section: Fixed

- Saving a custom template checks how deeply its groups nest with one lookup per step up the parent chain. A template
  of 1,500 nested frames and 500 groups used to keep the server busy for over a second.
