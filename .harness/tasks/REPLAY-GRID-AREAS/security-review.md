# Security review

Only CSS String values belonging to grid-template-areas can use the new exception. Each row is bounded to 2048 characters and nonempty whitespace-separated ASCII identifiers or dot placeholders. No arbitrary free text, punctuation, URL, generated content or custom-property string exception was added. Existing AST parsing, Raw rejection, allowed functions/at-rules/selectors and exact-origin resource validation remain in force. Escaped CSS values are checked after parsing.

SDK and player enforce the same rule independently. Snapshot style text, inserted stylesheet rules and style declaration mutations pass through it; input values/private roots and all protocol limits are unchanged. Unit regressions prove arbitrary strings, content and malicious URL-like rows remain rejected. No blocking findings.
