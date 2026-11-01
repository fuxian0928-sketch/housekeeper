# 上下文导航解析接口

`resolveReference({ query, kind?, projectId?, focus?, recentTargets? })` 是同步、只读服务，返回 `{ status: 'resolved' | 'ambiguous' | 'missing', target?, candidates, reason }`。只有 `resolved` 返回 `target`。`ambiguous` 的 `reason` 可直接用作短追问；不应在澄清前打开候选。模糊名称即使只剩一个候选也要求确认。

目标严格为 `{ kind: 'project' | 'document' | 'task' | 'page', id?, title }`。实际可打开的目标均具有 `id`。页面 `id` 固定为 `home / conversations / projects / tasks / knowledge / memory / capabilities / trash / settings`，与 `src/App.tsx` 的页面枚举一致。`validateNavigationTarget(target, projectId?)` 返回 `{ valid, target?, reason }`，成功结果会重新读取真实标题并剥离其他字段；页面跳转事件只能使用其规范化结果。打开前应再次校验，以免对象在解析后被删除。

调用方必须从真实 UI 选中对象和本次会话成功读取/打开结果注入 `focus` 与 `recentTargets`。它们不属于提供给模型自由填写的工具参数，不能来自模型声称“已看过”的文本。服务会重新校验标识、可见性、类型和项目范围。“这个”优先有效焦点；“刚才”优先无歧义的实际读取记录，没有记录时可用当前有效焦点；“上次/之前”必须有实际读取记录。多个近期候选会追问，列表顺序和更新时间都不能替代确认。明确名称未命中时不回退焦点。

`projectId` 一旦提供就是硬范围；空字符串、已删除、已归档或不存在的项目会被拒绝。文档只允许该项目手工关联、关联任务的文档或 `source_path` 目录内的真实索引记录。未指定范围时使用全局可见对象；项目回收站不会删除全局知识文档。项目已删除或归档时不可导航其项目与任务；文档物理删除及服务器删除标记同样不可导航。页面目标不携带范围，调用方在导航时必须保留传入的项目上下文，不可因打开列表而自动换成全部项目。

名称依据是真实项目名、任务标题、文档标题、文件名、相对路径和文档开头 YAML 中的简单字面 `alias/aliases`。当前没有项目/任务别名存储，服务不会编造别名或用模型猜测语义相似对象。文档仅内部读取前 4096 字符用于元数据别名，每类每次匹配查询最多读取 51 条命中记录、最多处理 20 个近期对象、最多返回 5 个仅含标识和标题的候选（标题最多 500 字符），不返回正文。截断不能被误认成唯一结果。

测试使用独立临时 SQLite 数据库并执行真实数据库迁移，无需安装新依赖。可通过 `createContextualNavigationService(database)` 注入数据库执行隔离测试。
