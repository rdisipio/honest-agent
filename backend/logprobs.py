import math
import re

CONFIDENCE_TAG_RE = re.compile(r"\[CONFIDENCE\s*:", re.IGNORECASE)


def _answer_span(content):
    """Drop the trailing [CONFIDENCE: ...] [SOURCE: ...] tag tokens so rigid,
    trivially-predictable boilerplate doesn't inflate the confidence average
    for the actual prose that precedes it."""
    offsets = []
    pos = 0
    for entry in content:
        offsets.append(pos)
        pos += len(entry["token"])

    full_text = "".join(entry["token"] for entry in content)
    match = CONFIDENCE_TAG_RE.search(full_text)
    if not match:
        return content

    tag_start = match.start()
    cut = next((i for i, off in enumerate(offsets) if off >= tag_start), len(content))
    return content[:cut] if cut > 0 else content


def attach_logprob_confidence(response: dict) -> dict:
    """Compute exp(avg_logprob) over the answer span (excluding the mandatory
    format tags) and attach it as `logprob_confidence` on the response. `None`
    if the upstream server didn't return per-token logprobs (e.g. some builds
    omit them during constrained tool-call decoding)."""
    choice = (response.get("choices") or [{}])[0]
    content = ((choice.get("logprobs") or {}).get("content")) or []

    if not content:
        response["logprob_confidence"] = None
        return response

    answer_span = _answer_span(content)
    avg_logprob = sum(entry["logprob"] for entry in answer_span) / len(answer_span)
    response["logprob_confidence"] = min(1.0, math.exp(avg_logprob))
    return response
