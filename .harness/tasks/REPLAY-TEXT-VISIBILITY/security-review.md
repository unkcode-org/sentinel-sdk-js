# Security review

The user explicitly requests capturing visible page text except control values.
This changes the previous default blanket text masking. Both rrweb masking and
pre-retention snapshot/addition/text-mutation admission use the same scoped text
policy. Private roots and input/textarea/select/option/contenteditable values
remain excluded even under an explicit public/unmask selector. Full masking via
maskTextSelector: "*" and selective data-sentinel-mask remain available.
Unknown/unsafe event fields, source attributes, storage, network bodies, script
surfaces and generated CSS text remain excluded. No raw event logging added.

Actual browser upload tests prove initial/default text, updated text, dynamically
inserted text/image and numeric scroll capture, with control/private canaries
absent and explicit full masking preserved in all three browser engines. Size,
queue lifetime, retries, policy freshness and wire/decoded caps are unchanged.
The isolated player still independently validates DOM/CSS/resources. User's
supplied client config lacked visual.enabled; resource admission must be enabled
and configured on both sides rather than removing URL/CSP restrictions.

No blocking finding introduced by this change within the authorized scope.
