section: Fixed

- Mermaid import keeps a flowchart node whose name starts with a keyword (`style1 --> B`, `clickA --> B`); such lines
  were skipped as if they were style or click lines, and their nodes and edges were missing.
- Mermaid import reads the activation shorthand of a sequence message (`A->>+B: hi`, `B-->>-A: ok`) as part of the
  arrow, so it no longer adds lifelines called `+B` and `-A`.
