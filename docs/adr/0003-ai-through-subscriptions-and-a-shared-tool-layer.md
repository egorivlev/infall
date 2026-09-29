# AI runs on Members' Claude subscriptions through a shared tool layer, not server-held API keys

Every Member has a Claude subscription and nobody wants to pay for API usage, but a subscription cannot be called from our server. So the server exposes Qoop's capabilities as one set of tools (an MCP endpoint), and AI reaches them three ways: from Claude's own apps as a connector, from the in-app sidebar which drives Claude Code on the Member's machine under their own login, and optionally from an OpenRouter key a Member chooses to add.

## Consequences

- The Claude sidebar exists only in the desktop app. Browser users get AI through a Claude app connector or their own OpenRouter key.
- AI never writes Research Content directly: it produces Suggestions that a Member accepts, or Conversation text that a Member Pins, always labelled AI-generated.
- Driving each Member's own Claude Code is assumed acceptable for a private team. This must be re-checked against Anthropic's terms before any public release, which will likely need a paid-API path instead.
- Optional OpenRouter keys are stored encrypted on the server and never returned to a browser; the server administrator can technically decrypt them.
