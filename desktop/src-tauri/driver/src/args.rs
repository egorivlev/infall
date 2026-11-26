//! The exact command line given to `claude`, and the MCP config file's contents.
//!
//! Every flag here was taken from `claude --help` of version 2.1.265; desktop/README.md says
//! what each is for. Nothing is ever passed through a shell: this is an argument vector.

use std::ffi::OsString;
use std::path::Path;

use serde_json::json;

use crate::RunRequest;

/// The name the Infall tool endpoint gets in the MCP config; tools become `mcp__infall__<tool>`.
pub const MCP_SERVER_NAME: &str = "infall";

/// The eight tools of docs/specs/api.md §12 — the only tools a run may use.
pub const INFALL_TOOLS: [&str; 8] = [
    "list_branches",
    "list_cards",
    "get_card",
    "list_connections",
    "list_sources",
    "list_suggestions",
    "suggest_source",
    "suggest_connection",
];

/// Environment variables set for the child on top of the inherited environment.
pub const CHILD_ENV: [(&str, &str); 2] = [
    // Do not load CLAUDE.md memory files (user, project, nested).
    ("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"),
    // Do not read or write Claude Code's automatic memory.
    ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"),
];

/// `mcp__infall__list_branches,mcp__infall__list_cards,…`
pub fn allowed_tools() -> String {
    INFALL_TOOLS
        .iter()
        .map(|tool| format!("mcp__{MCP_SERVER_NAME}__{tool}"))
        .collect::<Vec<_>>()
        .join(",")
}

/// The arguments after the program name. The token is NOT here: it is only in the file at
/// `mcp_config`. The prompt is not here either: it goes to standard input.
pub fn build_args(request: &RunRequest, mcp_config: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        // Print mode: answer and exit. The prompt is read from standard input.
        "--print",
        // One JSON event per line, with text arriving as it is written.
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--input-format",
        "text",
        // Only the MCP servers in our file; the Member's own servers are not loaded.
        "--strict-mcp-config",
        "--mcp-config",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    args.push(mcp_config.as_os_str().to_owned());
    // `--mcp-config`, `--tools` and `--allowedTools` take several values: each must be
    // followed by another option, never by free text.
    args.extend(
        [
            // No built-in tools at all: no shell, no files, no web, no sub-agents.
            "--tools",
            "",
            // The eight Infall tools may run without asking…
            "--allowedTools",
        ]
        .map(OsString::from),
    );
    args.push(allowed_tools().into());
    args.extend(
        [
            // …and anything else that would ask is refused: nobody is there to answer.
            "--permission-mode",
            "dontAsk",
            "--permission-prompts",
            "none",
            // No user, project or local settings files (so none of their hooks, plugins,
            // permissions or environment).
            "--setting-sources",
            "",
            // No skills or custom commands.
            "--disable-slash-commands",
            // No browser integration.
            "--no-chrome",
        ]
        .map(OsString::from),
    );
    // Caller-supplied text is attached with `=` so it can never be read as an option.
    args.push(format!("--append-system-prompt={}", request.system).into());
    if let Some(session) = &request.resume {
        args.push(format!("--resume={session}").into());
    }
    args
}

/// The MCP config file: one HTTP server, the Infall tool endpoint, with the access token.
pub fn mcp_config_json(request: &RunRequest) -> String {
    json!({
        "mcpServers": {
            MCP_SERVER_NAME: {
                "type": "http",
                "url": request.tools_url,
                "headers": { "Authorization": format!("Bearer {}", request.tools_token.expose()) }
            }
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Secret;

    fn request(resume: Option<&str>) -> RunRequest {
        RunRequest {
            prompt: "the prompt text".into(),
            system: "--dangerously-skip-permissions\nBe brief.".into(),
            resume: resume.map(str::to_owned),
            tools_url: "http://localhost:8787/mcp".into(),
            tools_token: Secret::new("infall_pat_SECRETSECRET"),
        }
    }

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|a| a.to_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn the_exact_argument_vector() {
        let args = strings(&build_args(
            &request(Some("abc-123")),
            Path::new("/t/mcp.json"),
        ));
        assert_eq!(
            args,
            vec![
                "--print",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--input-format",
                "text",
                "--strict-mcp-config",
                "--mcp-config",
                "/t/mcp.json",
                "--tools",
                "",
                "--allowedTools",
                "mcp__infall__list_branches,mcp__infall__list_cards,mcp__infall__get_card,mcp__infall__list_connections,mcp__infall__list_sources,mcp__infall__list_suggestions,mcp__infall__suggest_source,mcp__infall__suggest_connection",
                "--permission-mode",
                "dontAsk",
                "--permission-prompts",
                "none",
                "--setting-sources",
                "",
                "--disable-slash-commands",
                "--no-chrome",
                "--append-system-prompt=--dangerously-skip-permissions\nBe brief.",
                "--resume=abc-123",
            ]
        );
    }

    #[test]
    fn no_resume_no_flag_and_neither_token_nor_prompt_in_the_arguments() {
        let args = strings(&build_args(&request(None), Path::new("/t/mcp.json")));
        assert!(!args.iter().any(|a| a.starts_with("--resume")));
        assert!(!args.iter().any(|a| a.contains("SECRET")));
        assert!(!args.iter().any(|a| a.contains("the prompt text")));
        // Nothing dangerous is ever a separate argument.
        for forbidden in [
            "--dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
            "bypassPermissions",
        ] {
            assert!(!args.iter().any(|a| a == forbidden));
        }
    }

    #[test]
    fn the_config_file_names_one_http_server_with_the_token() {
        let v: serde_json::Value = serde_json::from_str(&mcp_config_json(&request(None))).unwrap();
        let servers = v["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers["infall"]["type"], "http");
        assert_eq!(servers["infall"]["url"], "http://localhost:8787/mcp");
        assert_eq!(
            servers["infall"]["headers"]["Authorization"],
            "Bearer infall_pat_SECRETSECRET"
        );
    }
}
