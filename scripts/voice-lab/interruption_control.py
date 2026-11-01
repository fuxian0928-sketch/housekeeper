"""Reject a delayed pause before it can freeze an unrelated playback window."""
def pause_candidate(segmenter, playback, generation, turn, pause_id, now):
    candidate = segmenter.interruption
    if candidate is None or type(pause_id) is not int or pause_id < 1:
        return False
    candidate.tick(now)
    if (segmenter.state != 'speaking' or candidate.key != (generation, turn, pause_id)
            or generation != segmenter.generation or turn != segmenter.turn):
        return False
    return playback.pause(generation, turn, pause_id, now=now)
