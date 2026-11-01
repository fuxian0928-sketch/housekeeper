// Public diagnostics are a projection, never raw traces or conversation content.
function voiceLatencyReport(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(-10).reverse().map(row => {
    const marks = row?.marks || {};
    const has = name => Number.isFinite(marks[name]) && marks[name] >= 0;
    const duration = (start,end) => has(start) && has(end) && marks[end] >= marks[start] ? Math.round(marks[end]-marks[start]) : null;
    const failed = ['response-failed','asr-failed','turn-failed'].some(has);
    const cancelled = ['response-cancelled','turn-cancelled'].some(has);
    return {
      startedAt: typeof row?.startedAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(row.startedAt) ? row.startedAt : null,
      status: failed ? 'failed' : cancelled ? 'cancelled' : has('playback-complete') ? 'submitted' : has('turn-finished') ? 'finished' : 'pending',
      asrWaitMs:duration('turn-end','asr-final'),
      ttsConnectMs:duration('tts-start','tts-ready'),
      answerFirstMs:duration('answer-start','first-answer-text'),
      ttsFirstMs:duration('first-sentence','first-answer-pcm'),
      responseWaitMs:duration('turn-end','first-answer-pcm')
    };
  });
}
module.exports={voiceLatencyReport};
