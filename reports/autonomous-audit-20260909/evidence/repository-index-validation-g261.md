# G261 repository-index search validation

`/repo-index/register` and `POST /repo-index/search` now validate their input shapes before invoking the repository index service:

- registration name/path/url types are checked
- query, filters and search type are checked

- `limit` must be an integer from 1 through 500
- `offset` must be an integer from 0 through 1,000,000
- zero, negative, fractional and non-numeric values return typed HTTP 400
- valid indexed search still returns HTTP 200 with matching results

The critical HTTP contract suite passes 9/9 tests, including the valid register/index/search/delete chain and twenty malformed registration/search/window assertions. This is local authenticated fixture evidence; external repository providers and production deployment remain unverified.
