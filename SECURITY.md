# Security

Report vulnerabilities through GitHub's **Security → Report a vulnerability**
when enabled, or contact a repository maintainer privately. Never publish keys,
database URLs, real query text or result data in public issues.

Start with `DB_ACCESS=read_only` and database credentials that have read-only
grants. Use schema/column policies and response budgets for additional controls;
the SQL classifier is not a replacement for database permissions. Functions and
procedures can contain SQL that application-level policy cannot inspect.

Use HTTPS for remote access and a strong bearer token. Node's bearer token grants
access to all configured connections at their configured access levels. Worker
OAuth can constrain tokens to read scope. Keep production credentials outside the
repository and Docker build context. Audit mode `sql` can include sensitive SQL
text; use `meta` unless that additional detail is required.

Production images can be pinned by digest. Source/SemVer tags are conventions,
not registry-enforced immutability; rebuilding can change the image digest.
