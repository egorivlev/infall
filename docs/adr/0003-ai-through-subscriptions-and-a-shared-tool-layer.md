# AI runs on Members' Claude subscriptions through a shared tool layer, not server-held API keys

Every Member has a Claude subscription and nobody wants to pay for API usage, but a subscription cannot be called from our server. So the server exposes Infall's capabilities as one set of tools (an MCP endpoint), and AI reaches them three ways: from Claude's own apps as a connector, from the in-app sidebar which drives Claude Code on the Member's machine under their own login, and optionally from an OpenRouter key a Member chooses to add.

## Consequences

- The Claude sidebar exists only in the desktop app. Browser users get AI through a Claude app connector or their own OpenRouter key.
- AI never writes Research Content directly: it produces Suggestions that a Member accepts, or Conversation text that a Member Pins, always labelled AI-generated.
- Driving each Member's own Claude Code was assumed acceptable for a private team, to be re-checked against Anthropic's terms before any public release. Re-checked on 27 November 2026: see below.
- Optional OpenRouter keys are stored encrypted on the server and never returned to a browser; the server administrator can technically decrypt them.

## Re-check against Anthropic's terms (27 November 2026)

Read: Claude Code's "Legal and compliance" page (code.claude.com/docs/en/legal-and-compliance) and the Agent SDK overview, as published that day. This is a reading of public documents, not legal advice, and Anthropic says it may enforce without notice.

What the pages require, and what Infall does (`desktop/src-tauri/driver`):

| The terms | Infall |
|---|---|
| "The Claude Code binary must not be modified", and must be "installed and run as published by Anthropic" | Infall does not ship Claude Code. It looks for the `claude` program the person installed themselves (their `PATH` and the usual install folders) and starts it as it is. |
| Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens"; no "Claude.ai login" offered in one's own application; no routing of requests through subscription credentials "on behalf of their users" | Infall has no sign-in to Claude of any kind and reads no credential, token or settings file of Claude Code. Only the `claude` process talks to Anthropic, under the login the person made in Claude Code itself. Infall's server never sees a request to Anthropic. |
| Customers "may not remove, disable, or restrict any authentication method built into it" | Infall passes no option about authentication. What it does pass limits the tools to Infall's own, turns off memory files and slash commands, and sets the output format: ordinary options of the published program. |
| Customers "may not pay for, resell, or intermediate Claude usage on their end users' behalf"; each end user authenticates with their own credentials and is billed directly | Each person uses their own Claude Code, signed in by themselves, on their own computer. Infall is free and charges for nothing. |
| The names: one may say "in plain text" that a product "runs Claude Code", but not use "Claude Code" or "Anthropic" in a product or feature name, or suggest endorsement | The feature is called **AI** (the AI sidebar). Texts say it works "through Claude Code". No logo, no Claude name in a feature name. Keep it so. |

The sentence this rests on: the rules do not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". Nothing on the pages speaks about a desktop app starting the person's own Claude Code in print mode, so this is a reading, with these open edges:

- The page says "preinstalling or running Claude Code in your products or services" requires agreeing to Anthropic's Commercial Terms of Service. Its examples are hosted sandboxes and agent infrastructure; whether a free program that starts the user's own local copy counts is not said. The conditions it lists are the ones in the table, and Infall meets them.
- The page tells developers of products that "interact with Claude's capabilities" to use API keys. A person may sign in to their own Claude Code with an API key instead of a subscription, and Infall works the same with either; Infall cannot restrict that choice and does not.
- Plans' advertised limits "assume ordinary, individual usage". One person asking in a sidebar is that; nothing in Infall runs Claude Code unattended or for someone else.
- How use through `claude -p` is counted against a subscription has changed before and may change again. That is between each person and Anthropic; it would change what the sidebar costs them, not whether Infall may start it.

Decision: the design stays. It may be released publicly as open source. A paid-API path is not needed for that; the OpenRouter key remains the route for people without Claude Code.

What must stay true, or this reading no longer holds: Infall never bundles or alters `claude`; never reads, asks for, stores or forwards a Claude credential; never offers its own sign-in to Claude; never runs Claude Code on a server or for a person other than the one at the computer; never puts Claude's name or marks in a feature's name. Read the two pages again before a 1.0 release, when Anthropic announces a change for programmatic use, and before Infall is ever sold. For certainty rather than a reading, describe the design to Anthropic and ask.
