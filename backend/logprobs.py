import math


def attach_logprob_confidence(response: dict) -> dict:
    """Compute exp(avg_logprob) over the answer span and attach it as
    `logprob_confidence` on the response. `None` if the upstream server
    didn't return per-token logprobs (e.g. some builds omit them during
    constrained tool-call decoding)."""
    choice = (response.get("choices") or [{}])[0]
    content = ((choice.get("logprobs") or {}).get("content")) or []

    if not content:
        response["logprob_confidence"] = None
        return response

    avg_logprob = sum(entry["logprob"] for entry in content) / len(content)
    response["logprob_confidence"] = min(1.0, math.exp(avg_logprob))
    return response
