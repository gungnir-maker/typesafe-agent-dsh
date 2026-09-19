# TypeSafe Local AI

Private quality gate for AI output.

The first MVP validates a typed completion claim, checks changed-file boundaries, runs trusted verification commands, and optionally asks a local Ollama model for semantic review.

## Run

```bash
python3 -m unittest discover -s tests -v
python3 -m src.cli demo
```

Optional local model review:

```bash
ollama run llama3.2
python3 -m src.cli review examples/completion.json --model llama3.2
```

The local model is a reviewer. It never replaces deterministic checks.

## MVP flow

```text
completion JSON -> typed validation -> file policy -> trusted checks -> local review -> report
```

