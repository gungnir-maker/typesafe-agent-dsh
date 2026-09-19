from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import asdict

from .core import Completion, Review


class OllamaCritic:
    def __init__(self, model: str = "llama3.2", endpoint: str = "http://localhost:11434/api/generate"):
        self.model = model
        self.endpoint = endpoint

    def review(self, completion: Completion) -> Review:
        prompt = (
            "Review this AI completion claim. Return JSON only with keys: accepted (boolean), "
            "score (number 0 to 1), problems (array of {code,message,severity}), "
            "suggestedFixes (array of strings). Reject unsupported or incomplete claims.\n\n"
            + json.dumps(asdict(completion), indent=2)
        )
        body = json.dumps({"model": self.model, "prompt": prompt, "stream": False, "format": "json"}).encode()
        request = urllib.request.Request(self.endpoint, data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                raw = json.loads(response.read())
            result = json.loads(raw["response"])
            return Review(
                accepted=bool(result["accepted"]),
                score=float(result["score"]),
                problems=result.get("problems", []),
                suggested_fixes=result.get("suggestedFixes", []),
                source=f"ollama:{self.model}",
            )
        except (OSError, urllib.error.URLError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
            return Review(False, 0.0, [{"code": "LOCAL_MODEL_UNAVAILABLE", "message": str(error), "severity": "high"}], source="ollama")

