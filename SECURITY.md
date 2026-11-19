# Security

apex-context reads local agent session logs, so privacy bugs are security bugs. Examples: any output, error, state file or message that contains prompt text, assistant text, file paths, project names, commands or tool output; any network access; any write into the folders it reads.

Report privately, not in a public issue. Use GitHub's private vulnerability reporting: https://github.com/apex-context-dev/apex-context/security/advisories/new

Include the version (`apex-context --version`), the command, and a synthetic reproduction. Please do not send real logs.

Supported: the latest release.
