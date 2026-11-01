import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, Search, X } from "lucide-react";
import { api } from "../../api";
import type { ChatMessage } from "../../types";
import { ChatTranscript } from "./ChatTranscript";
import {ChatToolActivity} from './ChatToolActivity';
import {FeedbackBanner} from '../../components/FeedbackBanner';

type RecordMessage = ChatMessage & {
  conversationId: string;
  channel: "voice" | "text";
};
type RecordPage = {
  messages: RecordMessage[];
  hasMore: boolean;
  nextCursor: string | null;
  query: string;
};
const emptyPage: RecordPage = {
  messages: [],
  hasMore: false,
  nextCursor: null,
  query: "",
};
export function ConversationRecords({
  messages,
  conversationId,
  busy,
  loading,
  renderMessage,
  onClose,
  active = true,
}: {
  messages: ChatMessage[];
  conversationId: string | null;
  busy: boolean;
  loading: boolean;
  renderMessage: (message: ChatMessage, index: number | null) => ReactNode;
  onClose?: () => void;
  active?: boolean;
}) {
  const [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState(""),
    [appliedQuery, setAppliedQuery] = useState(""),
    [composing, setComposing] = useState(false);
  const [page, setPage] = useState<RecordPage>(emptyPage),
    [pending, setPending] = useState(true),
    [loadingMore, setLoadingMore] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null),
    searchButtonRef = useRef<HTMLButtonElement>(null),
    moreRequest = useRef<AbortController | null>(null);
  const loadedEarlier = useRef(false),
    previousQuery = useRef(appliedQuery);
  const loadedQuery=useRef<string|null>(null);
  const latestMessageId = messages.at(-1)?.id;
  useEffect(() => {
    if (composing) return;
    const timer = window.setTimeout(() => setAppliedQuery(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query, composing]);
  useEffect(() => {
    if (searchOpen) inputRef.current?.focus();
  }, [searchOpen]);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    moreRequest.current?.abort();
    setLoadingMore(false);
    setPending(loadedQuery.current!==appliedQuery);
    setError("");
    if (previousQuery.current !== appliedQuery) {
      previousQuery.current = appliedQuery;
      loadedEarlier.current = false;
    }
    void api
      .get<RecordPage>(
        "/conversations/messages" +
          (appliedQuery ? "?q=" + encodeURIComponent(appliedQuery) : ""),
        { signal: controller.signal },
      )
      .then((value) => {
        if(!controller.signal.aborted)loadedQuery.current=value.query;
        if (!controller.signal.aborted)
          setPage((current) => {
            if (
              !loadedEarlier.current ||
              current.query !== value.query ||
              !value.messages.length
            )
              return value;
            const merged = new Map(
              current.messages.map((item) => [item.id, item]),
            );
            for (const item of value.messages) merged.set(item.id, item);
            return {
              ...current,
              messages: [...merged.values()].sort((a, b) =>
                a.createdAt!.localeCompare(b.createdAt!),
              ),
            };
          });
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "记录暂时无法读取，请重试。",
          );
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => controller.abort();
  }, [appliedQuery, conversationId, busy, latestMessageId, retry, active]);
  useEffect(() => () => moreRequest.current?.abort(), []);
  const records = useMemo(() => {
    const result = page.messages
        .filter(
          (message) =>
            !appliedQuery ||
            message.content
              .toLocaleLowerCase()
              .includes(appliedQuery.toLocaleLowerCase()),
        )
        .map((message) => ({
          message: message as ChatMessage,
          index: null as number | null,
        })),
      claimed = new Set<number>(),
      oldest = page.messages[0]?.createdAt;
    messages.forEach((message, index) => {
      if (!oldest && index < messages.length - 40) return;
      if (
        appliedQuery &&
        !message.content
          .toLocaleLowerCase()
          .includes(appliedQuery.toLocaleLowerCase())
      )
        return;
      let found = result.findIndex(
        (item) => message.id && item.message.id === message.id,
      );
      if (found < 0 && message.createdAt)
        for (let n = result.length - 1; n >= 0; n--) {
          const stored = result[n].message as RecordMessage;
          if (
            !claimed.has(n) &&
            stored.conversationId === conversationId &&
            stored.role === message.role &&
            stored.content === message.content &&
            Math.abs(
              Date.parse(stored.createdAt!) - Date.parse(message.createdAt),
            ) < 5000
          ) {
            found = n;
            break;
          }
        }
      if (found >= 0) {
        claimed.add(found);
        result[found] = {
          message: { ...result[found].message, ...message },
          index,
        };
      } else if (!oldest || !message.createdAt || message.createdAt >= oldest)
        result.push({ message, index });
    });
    return result.sort((a, b) => {
      if (!a.message.createdAt && !b.message.createdAt) return 0;
      if (!a.message.createdAt) return 1;
      if (!b.message.createdAt) return -1;
      return a.message.createdAt.localeCompare(b.message.createdAt);
    });
  }, [page.messages, messages, conversationId, appliedQuery]);
  const closeSearch = () => {
    setSearchOpen(false);
    setComposing(false);
    setQuery("");
    setAppliedQuery("");
    searchButtonRef.current?.focus();
  };
  const loadEarlier = async () => {
    if (!page.nextCursor || loadingMore || pending) return;
    const controller = new AbortController();
    moreRequest.current?.abort();
    moreRequest.current = controller;
    setLoadingMore(true);
    setError("");
    try {
      const value = await api.get<RecordPage>(
        "/conversations/messages?" +
          new URLSearchParams({
            before: page.nextCursor,
            ...(appliedQuery ? { q: appliedQuery } : {}),
          }),
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        loadedEarlier.current = true;
        setPage((current) => {
          const ids = new Set(current.messages.map((item) => item.id));
          return {
            ...value,
            messages: [
              ...value.messages.filter((item) => !ids.has(item.id)),
              ...current.messages,
            ],
          };
        });
      }
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          reason instanceof Error
            ? reason.message
            : "更早消息读取失败，请重试。",
        );
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  };
  const waiting = pending || query.trim() !== appliedQuery;
  return (
    <>
      <header className="workbench-detail-heading chat-records-heading">
        <div className={`chat-records-search${searchOpen ? " is-open" : ""}`}>
          <button
            ref={searchButtonRef}
            type="button"
            className="icon-button"
            aria-label={searchOpen ? "收起搜索" : "搜索对话"}
            title={searchOpen ? "收起搜索" : "搜索对话"}
            aria-expanded={searchOpen}
            aria-controls="chat-record-search"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          >
            <Search size={15} />
          </button>
          {searchOpen ? (
            <div className="chat-records-search-field">
              <input
                ref={inputRef}
                id="chat-record-search"
                type="search"
                aria-label="搜索对话内容"
                placeholder="搜索对话"
                maxLength={200}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => setComposing(false)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    closeSearch();
                  }
                }}
              />
              {query ? (
                <button
                  className="icon-button"
                  type="button"
                  aria-label="清空搜索"
                  onClick={() => {
                    setQuery("");
                    setAppliedQuery("");
                    inputRef.current?.focus();
                  }}
                >
                  <X size={13} />
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        {onClose ? <button
          type="button"
          className="icon-button"
          aria-label="关闭详情面板"
          data-tooltip="关闭面板"
          onClick={onClose}
        >
          <X size={15} />
        </button> : null}
      </header>
      {searchOpen && query.trim() ? (
        <p className="chat-records-search-status" role="status">
          {waiting
            ? "正在搜索…"
            : error
              ? "搜索未完成"
              : `显示 ${records.length} 条匹配消息`}
        </p>
      ) : null}
      {error ? (
        <FeedbackBanner tone="error" action={<button
            type="button"
            className="text-button"
            onClick={() => setRetry((value) => value + 1)}
          >
            重试
          </button>}>
          {error}
        </FeedbackBanner>
      ) : null}
      <ChatToolActivity active={active}/>
      <ChatTranscript
        active={active}
        conversationId={"all-records:" + appliedQuery}
        loading={loading || waiting}
        hasMessages={records.length > 0}
        hasEarlier={page.hasMore}
        loadingEarlier={loadingMore}
        onLoadEarlier={() => void loadEarlier()}
      >
        {waiting && !records.length ? (
          <p className="workbench-empty-note" role="status">
            <LoaderCircle size={14} className="spin" />
            正在读取消息…
          </p>
        ) : records.length ? (
          records.map((item) => renderMessage(item.message, item.index))
        ) : (
          <p className="workbench-empty-note">
            {error
              ? "记录暂时无法读取。"
              : appliedQuery
                ? "没有找到匹配的对话内容。"
                : "语音和文字聊天会记录在这里。"}
          </p>
        )}
      </ChatTranscript>
    </>
  );
}
