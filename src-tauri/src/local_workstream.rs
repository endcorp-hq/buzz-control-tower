//! Source-redacted local Codex runtime observer.
//!
//! The companion reads append-only rollout JSONL files from the current user's
//! local Codex session directory. Raw prompts, reasoning, tool arguments, tool
//! output, and encrypted model content never cross the Tauri command boundary.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_SESSION_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_CANDIDATE_FILES: usize = 64;
const MAX_ACTIVITY_EVENTS: usize = 200;
const MAX_CONTEXT_SOURCES: usize = 16;
const MAX_VISIBLE_TEXT: usize = 1_200;
const MAX_VISIBLE_RESULT: usize = 4_000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeParameter {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeActivity {
    pub id: String,
    pub at: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
    pub status: String,
    pub parameters: Vec<RuntimeParameter>,
    pub result: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeContextSource {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub detail: String,
    pub hash: String,
    pub size: String,
    pub visibility: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<RuntimeContextField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub withheld_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeContextField {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvidence {
    pub stage: String,
    pub label: String,
    pub detail: String,
    pub complete: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeArtifact {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub detail: String,
    pub changed_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeWorkstreamPage {
    pub channel_id: String,
    pub agent_pubkey: String,
    pub agent_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_label: Option<String>,
    pub session_id: String,
    pub turn_id: String,
    pub status: String,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub model: String,
    pub workspace: String,
    pub activity: Vec<RuntimeActivity>,
    pub context: Vec<RuntimeContextSource>,
    pub evidence: Vec<RuntimeEvidence>,
    pub artifacts: Vec<RuntimeArtifact>,
}

#[derive(Debug)]
struct RolloutLine {
    raw: String,
    value: Value,
}

fn sessions_root() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "cannot locate the current user's home directory".to_string())?;
    Ok(home.join(".codex").join("sessions"))
}

fn collect_jsonl_files(directory: &Path, depth: usize, files: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            collect_jsonl_files(&path, depth - 1, files);
        } else if file_type.is_file() && path.extension().is_some_and(|value| value == "jsonl") {
            files.push(path);
        }
    }
}

fn modified_at(path: &Path) -> SystemTime {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

fn read_rollout(path: &Path) -> Result<Vec<RolloutLine>, String> {
    let metadata = path
        .metadata()
        .map_err(|error| format!("inspect local runtime session: {error}"))?;
    if metadata.len() > MAX_SESSION_BYTES {
        return Err("local runtime session exceeds the 16 MiB safety limit".to_string());
    }
    let mut file =
        File::open(path).map_err(|error| format!("open local runtime session: {error}"))?;
    let tail_start = metadata.len().saturating_sub(MAX_TAIL_BYTES);
    file.seek(SeekFrom::Start(tail_start))
        .map_err(|error| format!("seek local runtime session: {error}"))?;
    let mut reader = BufReader::new(file);
    if tail_start > 0 {
        let mut partial_line = String::new();
        reader
            .read_line(&mut partial_line)
            .map_err(|error| format!("align local runtime session tail: {error}"))?;
    }
    let mut lines = Vec::new();
    for line in reader.lines() {
        let raw = line.map_err(|error| format!("read local runtime session: {error}"))?;
        if raw.trim().is_empty() {
            continue;
        }
        let value = serde_json::from_str(&raw)
            .map_err(|error| format!("decode local runtime session: {error}"))?;
        lines.push(RolloutLine { raw, value });
    }
    Ok(lines)
}

fn payload_type(value: &Value) -> Option<&str> {
    value.get("payload")?.get("type")?.as_str()
}

fn timestamp(value: &Value) -> String {
    value
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn short_hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))[..12].to_string()
}

fn byte_size(bytes: usize) -> String {
    if bytes >= 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

fn truncate_to(value: &str, limit: usize) -> String {
    let mut result = value.chars().take(limit).collect::<String>();
    if value.chars().count() > limit {
        result.push('…');
    }
    result
}

fn redact_with_limit(value: &str, limit: usize) -> String {
    let secret_assignment = Regex::new(
        r#"(?i)\b(api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*[\"']?[^\s\"'`]+"#,
    )
    .expect("valid secret assignment regex");
    let credential = Regex::new(r"\b(?:nsec1|sk-|gh[pousr]_|tskey-)[A-Za-z0-9_-]{8,}\b")
        .expect("valid credential regex");
    let private_sized_hex =
        Regex::new(r"\b[0-9a-fA-F]{64}\b").expect("valid private-sized hex regex");

    let assigned = secret_assignment.replace_all(value, "$1=[redacted]");
    let credentials = credential.replace_all(&assigned, "[redacted-credential]");
    let hex = private_sized_hex.replace_all(&credentials, "[redacted-64]");
    truncate_to(&hex, limit)
}

pub(crate) fn redact_visible(value: &str) -> String {
    redact_with_limit(value, MAX_VISIBLE_TEXT)
}

pub(crate) fn redact_result(value: &str) -> String {
    redact_with_limit(value, MAX_VISIBLE_RESULT)
}

fn triggering_buzz_content(message: &str) -> Option<String> {
    let event_start = message.rfind("[Buzz event:")?;
    let content_marker = "\nContent:";
    let content_start =
        message[event_start..].find(content_marker)? + event_start + content_marker.len();
    let tail = &message[content_start..];
    let content_end = ["\nTags:", "\nParsed:"]
        .into_iter()
        .filter_map(|marker| tail.find(marker))
        .min()
        .unwrap_or(tail.len());
    let content = tail[..content_end].trim();
    (!content.is_empty()).then(|| redact_result(content))
}

fn withheld_context_sources(message: &str, prefix: &str) -> Vec<RuntimeContextSource> {
    let header = Regex::new(r"(?m)^\[([^\]\r\n]{1,96})\]\r?$").expect("valid context header regex");
    let matches = header
        .captures_iter(message)
        .filter_map(|capture| {
            Some((
                capture.get(0)?.start(),
                capture.get(1)?.as_str().trim().to_ascii_lowercase(),
            ))
        })
        .collect::<Vec<_>>();
    let mut sources = Vec::new();
    let mut seen = Vec::new();
    for (index, (start, name)) in matches.iter().enumerate() {
        let presentation = match name.as_str() {
            "base" => Some((
                "base",
                "Base instructions",
                "Raw platform instructions stay at the runtime source because they can contain security policy and internal control text.",
            )),
            "system" => Some((
                "team",
                "System and team instructions",
                "Raw system and team instructions stay at the runtime source because they can contain operational policy and private workspace guidance.",
            )),
            value if value.starts_with("agent memory") => Some((
                "memory",
                "Agent memory",
                "Raw durable memory stays at the runtime source because it can contain private operational history or credential-adjacent material.",
            )),
            "channel canvas" => Some((
                "canvas",
                "Channel canvas",
                "The canvas body stays in Buzz; this record proves which injected revision shaped the turn without duplicating channel state.",
            )),
            "context" => Some((
                "thread",
                "Thread envelope",
                "The full thread envelope stays at the runtime source. The human-authored triggering request is exposed separately when it can be isolated safely.",
            )),
            _ => None,
        };
        let Some((kind, label, reason)) = presentation else {
            continue;
        };
        if seen.iter().any(|seen_name: &String| seen_name == name) {
            continue;
        }
        seen.push(name.clone());
        let end = matches
            .get(index + 1)
            .map(|(next_start, _)| *next_start)
            .unwrap_or(message.len());
        let raw = &message.as_bytes()[*start..end];
        sources.push(RuntimeContextSource {
            id: format!("{prefix}-context-{}", sources.len()),
            kind: kind.into(),
            label: label.into(),
            detail: "This context section was supplied to the runtime; select it to inspect its visibility boundary.".into(),
            hash: short_hash(raw),
            size: byte_size(raw.len()),
            visibility: "provenance".into(),
            content: None,
            fields: Vec::new(),
            withheld_reason: Some(reason.into()),
        });
    }
    sources
}

fn extracted_tool_names(input: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut remaining = input;
    while let Some(index) = remaining.find("tools.") {
        let after = &remaining[index + "tools.".len()..];
        let name = after
            .chars()
            .take_while(|character| character.is_ascii_alphanumeric() || *character == '_')
            .collect::<String>();
        let name_len = name.len();
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
        remaining = &after[name_len..];
    }
    names
}

fn js_string_property(input: &str, name: &str) -> Option<String> {
    let property = Regex::new(&format!(r#"(?m)(?:\b{}|[\"']{}[\"'])\s*:\s*"#, name, name))
        .expect("valid property regex");
    let start = property.find(input)?.end();
    let mut deserializer = serde_json::Deserializer::from_str(&input[start..]);
    String::deserialize(&mut deserializer).ok()
}

fn first_command_line(command: &str) -> String {
    let line = command
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("command");
    truncate_to(line.trim(), 96)
}

fn tool_presentation(input: &str, fallback: &str) -> (String, String, Vec<RuntimeParameter>) {
    let tool_names = extracted_tool_names(input);
    let labels = tool_names
        .iter()
        .map(|name| match name.as_str() {
            "exec_command" => "Shell command".to_string(),
            "apply_patch" => "File patch".to_string(),
            "view_image" => "Image inspection".to_string(),
            "update_plan" => "Plan update".to_string(),
            "write_stdin" => "Interactive command".to_string(),
            "web__run" => "Web research".to_string(),
            other => other.replace('_', " "),
        })
        .collect::<Vec<_>>();
    let fallback_label = if labels.is_empty() {
        match fallback {
            "wait" => "Wait for operation".to_string(),
            _ => "Workspace operation".to_string(),
        }
    } else {
        labels.join(" + ")
    };

    if tool_names.iter().any(|name| name == "exec_command") {
        let command =
            js_string_property(input, "cmd").unwrap_or_else(|| "Command unavailable".into());
        let mut parameters = vec![RuntimeParameter {
            label: "Command".into(),
            value: redact_result(&command),
        }];
        if let Some(workdir) = js_string_property(input, "workdir") {
            parameters.push(RuntimeParameter {
                label: "Working directory".into(),
                value: redact_result(&workdir),
            });
        }
        return (
            format!("Ran {}", first_command_line(&redact_visible(&command))),
            "Local command parameters are available below.".into(),
            parameters,
        );
    }

    if tool_names.iter().any(|name| name == "apply_patch") {
        return (
            "Edited files".into(),
            "Patch bodies stay withheld; changed paths are recorded as artifacts.".into(),
            Vec::new(),
        );
    }

    if tool_names.iter().any(|name| name == "view_image") {
        let parameters = js_string_property(input, "path")
            .map(|path| RuntimeParameter {
                label: "Path".into(),
                value: redact_result(&path),
            })
            .into_iter()
            .collect();
        return (
            "Viewed image".into(),
            "Inspected a local image.".into(),
            parameters,
        );
    }

    (fallback_label, "Local tool activity.".into(), Vec::new())
}

fn visible_tool_result(output: &str) -> Option<String> {
    let blocks = serde_json::from_str::<Value>(output).ok()?;
    let text = blocks
        .as_array()?
        .iter()
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    (!text.trim().is_empty()).then(|| redact_result(text.trim()))
}

fn safe_path(path: &str, roots: &[PathBuf]) -> String {
    let candidate = Path::new(path);
    for root in roots {
        if let Ok(relative) = candidate.strip_prefix(root) {
            return relative.to_string_lossy().to_string();
        }
    }
    candidate
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "workspace artifact".to_string())
}

fn artifact_kind(path: &str) -> String {
    match Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "txt" | "pdf" | "doc" | "docx" => "document",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" => "image",
        _ => "code",
    }
    .to_string()
}

fn latest_trigger_matches(lines: &[RolloutLine], channel_id: &str, agent_pubkey: &str) -> bool {
    lines
        .iter()
        .rev()
        .find(|line| payload_type(&line.value) == Some("user_message"))
        .and_then(|line| line.value.get("payload")?.get("message")?.as_str())
        .is_some_and(|message| message.contains(channel_id) && message.contains(agent_pubkey))
}

fn parse_workstream(
    lines: &[RolloutLine],
    channel_id: &str,
    agent_pubkey: &str,
    agent_name: &str,
) -> Result<RuntimeWorkstreamPage, String> {
    if !latest_trigger_matches(lines, channel_id, agent_pubkey) {
        return Err("local runtime session does not match the selected channel and agent".into());
    }

    let start_index = lines
        .iter()
        .rposition(|line| payload_type(&line.value) == Some("task_started"))
        .ok_or_else(|| "local runtime session has no active turn".to_string())?;
    let turn_lines = &lines[start_index..];
    let started = &turn_lines[0];
    let turn_id = started
        .value
        .get("payload")
        .and_then(|payload| payload.get("turn_id"))
        .and_then(Value::as_str)
        .unwrap_or("unknown-turn")
        .to_string();
    let started_at = started
        .value
        .get("payload")
        .and_then(|payload| payload.get("started_at"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| timestamp(&started.value));
    let session_id = lines
        .iter()
        .find(|line| line.value.get("type").and_then(Value::as_str) == Some("session_meta"))
        .and_then(|line| line.value.get("payload")?.get("session_id")?.as_str())
        .unwrap_or("unknown-session")
        .to_string();

    let mut activity = Vec::new();
    let mut context = Vec::new();
    let mut artifacts = Vec::new();
    let mut evidence = Vec::new();
    let mut tool_events: HashMap<String, usize> = HashMap::new();
    let mut roots = Vec::new();
    let mut model = "Not exposed".to_string();
    let mut workspace = "Local workspace".to_string();
    let mut completed_at = None;

    activity.push(RuntimeActivity {
        id: format!("{turn_id}-started"),
        at: started_at.clone(),
        kind: "lifecycle".into(),
        title: "Turn started".into(),
        detail: "The local agent runtime accepted this turn.".into(),
        status: "complete".into(),
        parameters: Vec::new(),
        result: None,
    });

    for (offset, line) in turn_lines.iter().enumerate() {
        let event_type = line.value.get("type").and_then(Value::as_str);
        match (event_type, payload_type(&line.value)) {
            (Some("turn_context"), _) => {
                let mut fields = Vec::new();
                if let Some(value) = line.value.get("payload") {
                    if let Some(value_model) = value.get("model").and_then(Value::as_str) {
                        model = redact_visible(value_model);
                    }
                    if let Some(cwd) = value.get("cwd").and_then(Value::as_str) {
                        let cwd_path = PathBuf::from(cwd);
                        workspace = cwd_path
                            .file_name()
                            .map(|part| part.to_string_lossy().to_string())
                            .unwrap_or_else(|| "Local workspace".to_string());
                        roots.push(cwd_path);
                    }
                    if let Some(workspace_roots) =
                        value.get("workspace_roots").and_then(Value::as_array)
                    {
                        roots.extend(
                            workspace_roots
                                .iter()
                                .filter_map(Value::as_str)
                                .map(PathBuf::from),
                        );
                    }
                    fields.push(RuntimeContextField {
                        label: "Workspace".into(),
                        value: workspace.clone(),
                    });
                    fields.push(RuntimeContextField {
                        label: "Model".into(),
                        value: model.clone(),
                    });
                    if let Some(policy) = value.get("approval_policy").and_then(Value::as_str) {
                        fields.push(RuntimeContextField {
                            label: "Approval policy".into(),
                            value: redact_visible(policy),
                        });
                    }
                    if let Some(policy) = value.get("sandbox_policy") {
                        fields.push(RuntimeContextField {
                            label: "Sandbox policy".into(),
                            value: redact_visible(&policy.to_string()),
                        });
                    }
                }
                context.push(RuntimeContextSource {
                    id: format!("{turn_id}-runtime-context"),
                    kind: "repository".into(),
                    label: "Runtime context".into(),
                    detail: "Safe runtime metadata for the selected local Codex session.".into(),
                    hash: short_hash(line.raw.as_bytes()),
                    size: byte_size(line.raw.len()),
                    visibility: "full".into(),
                    content: None,
                    fields,
                    withheld_reason: None,
                });
            }
            (Some("event_msg"), Some("user_message")) => {
                let message = line
                    .value
                    .get("payload")
                    .and_then(|payload| payload.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let visible_trigger = triggering_buzz_content(message);
                let withheld_reason = visible_trigger.is_none().then(|| {
                    "The exporter could not distinguish the human request from the surrounding runtime envelope, so it kept the body at source.".into()
                });
                context.push(RuntimeContextSource {
                    id: format!("{turn_id}-trigger"),
                    kind: "thread".into(),
                    label: "Triggering Buzz turn".into(),
                    detail: if visible_trigger.is_some() {
                        "The human-authored Buzz request that started this runtime turn."
                    } else {
                        "The triggering payload was present, but its human-authored content could not be isolated safely."
                    }
                    .into(),
                    hash: short_hash(line.raw.as_bytes()),
                    size: byte_size(line.raw.len()),
                    visibility: if visible_trigger.is_some() {
                        "summary"
                    } else {
                        "provenance"
                    }
                    .into(),
                    content: visible_trigger,
                    fields: Vec::new(),
                    withheld_reason,
                });
                context.extend(withheld_context_sources(message, &turn_id));
                activity.push(RuntimeActivity {
                    id: format!("{turn_id}-request"),
                    at: timestamp(&line.value),
                    kind: "lifecycle".into(),
                    title: "Request received".into(),
                    detail: "Safe trigger context is available under Context; the surrounding runtime envelope remains withheld.".into(),
                    status: "complete".into(),
                    parameters: Vec::new(),
                    result: None,
                });
            }
            (Some("event_msg"), Some("agent_reasoning")) => {
                let summary = line
                    .value
                    .get("payload")
                    .and_then(|payload| payload.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("Thinking")
                    .trim()
                    .trim_matches('*')
                    .trim();
                if !summary.is_empty() {
                    activity.push(RuntimeActivity {
                        id: format!("{turn_id}-thinking-{offset}"),
                        at: timestamp(&line.value),
                        kind: "lifecycle".into(),
                        title: "Thinking".into(),
                        detail: redact_visible(summary),
                        status: "complete".into(),
                        parameters: Vec::new(),
                        result: None,
                    });
                }
            }
            (Some("event_msg"), Some("agent_message")) => {
                let payload = line.value.get("payload").unwrap_or(&Value::Null);
                let message = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Agent update emitted");
                let phase = payload
                    .get("phase")
                    .and_then(Value::as_str)
                    .unwrap_or("commentary");
                activity.push(RuntimeActivity {
                    id: format!("{turn_id}-message-{offset}"),
                    at: timestamp(&line.value),
                    kind: "message".into(),
                    title: if phase == "final" {
                        "Result prepared"
                    } else {
                        "Progress update"
                    }
                    .into(),
                    detail: redact_visible(message),
                    status: "complete".into(),
                    parameters: Vec::new(),
                    result: None,
                });
            }
            (Some("response_item"), Some("custom_tool_call" | "function_call")) => {
                let payload = line.value.get("payload").unwrap_or(&Value::Null);
                let call_id = payload
                    .get("call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown-call")
                    .to_string();
                let input = payload
                    .get("input")
                    .or_else(|| payload.get("arguments"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let fallback = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let (title, detail, parameters) = tool_presentation(input, fallback);
                tool_events.insert(call_id.clone(), activity.len());
                activity.push(RuntimeActivity {
                    id: call_id,
                    at: timestamp(&line.value),
                    kind: "tool".into(),
                    title,
                    detail,
                    status: "running".into(),
                    parameters,
                    result: None,
                });
            }
            (Some("response_item"), Some("custom_tool_call_output" | "function_call_output")) => {
                let call_id = line
                    .value
                    .get("payload")
                    .and_then(|payload| payload.get("call_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if let Some(index) = tool_events.get(call_id).copied() {
                    activity[index].status = "complete".into();
                    activity[index].detail = "Local tool completed.".into();
                    activity[index].result = line
                        .value
                        .get("payload")
                        .and_then(|payload| payload.get("output"))
                        .and_then(Value::as_str)
                        .and_then(visible_tool_result);
                }
            }
            (Some("event_msg"), Some("patch_apply_end")) => {
                let payload = line.value.get("payload").unwrap_or(&Value::Null);
                let success = payload
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let changed_at = timestamp(&line.value);
                let paths = payload
                    .get("changes")
                    .and_then(Value::as_object)
                    .map(|changes| {
                        changes
                            .keys()
                            .map(|path| safe_path(path, &roots))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if !paths.is_empty() {
                    activity.push(RuntimeActivity {
                        id: format!("{turn_id}-patch-{offset}"),
                        at: changed_at.clone(),
                        kind: "evidence".into(),
                        title: if success {
                            "Files changed"
                        } else {
                            "File change failed"
                        }
                        .into(),
                        detail: paths.join(", "),
                        status: if success { "complete" } else { "failed" }.into(),
                        parameters: Vec::new(),
                        result: None,
                    });
                    for (path_index, path) in paths.iter().enumerate() {
                        artifacts.push(RuntimeArtifact {
                            id: format!("{turn_id}-artifact-{offset}-{path_index}"),
                            kind: artifact_kind(path),
                            name: Path::new(path)
                                .file_name()
                                .map(|value| value.to_string_lossy().to_string())
                                .unwrap_or_else(|| path.clone()),
                            detail: path.clone(),
                            changed_at: changed_at.clone(),
                        });
                    }
                }
            }
            (Some("event_msg"), Some("task_complete")) => {
                let completed = line
                    .value
                    .get("payload")
                    .and_then(|payload| payload.get("completed_at"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| timestamp(&line.value));
                completed_at = Some(completed.clone());
                activity.push(RuntimeActivity {
                    id: format!("{turn_id}-complete"),
                    at: completed,
                    kind: "lifecycle".into(),
                    title: "Turn completed".into(),
                    detail: "The local runtime completed this turn.".into(),
                    status: "complete".into(),
                    parameters: Vec::new(),
                    result: None,
                });
            }
            _ => {}
        }
    }

    if !activity.is_empty() {
        evidence.push(RuntimeEvidence {
            stage: "local".into(),
            label: "Runtime observed".into(),
            detail: "Lifecycle and tool events were reduced locally with source-side redaction."
                .into(),
            complete: true,
        });
        for (stage, label) in [
            ("committed", "No commit evidence"),
            ("pushed", "No push evidence"),
            ("pr-open", "No pull request evidence"),
            ("merged", "No merge evidence"),
            ("deployed", "No deployment evidence"),
        ] {
            evidence.push(RuntimeEvidence {
                stage: stage.into(),
                label: label.into(),
                detail: "The exporter does not infer delivery from tool activity.".into(),
                complete: false,
            });
        }
    }

    let mut artifacts_by_path = HashMap::new();
    for artifact in artifacts {
        artifacts_by_path.insert(artifact.detail.clone(), artifact);
    }
    let mut artifacts = artifacts_by_path.into_values().collect::<Vec<_>>();
    artifacts.sort_by(|left, right| right.changed_at.cmp(&left.changed_at));

    if activity.len() > MAX_ACTIVITY_EVENTS {
        activity.drain(1..activity.len() - MAX_ACTIVITY_EVENTS + 1);
    }
    context.truncate(MAX_CONTEXT_SOURCES);

    Ok(RuntimeWorkstreamPage {
        channel_id: channel_id.to_string(),
        agent_pubkey: agent_pubkey.to_string(),
        agent_name: agent_name.to_string(),
        source_label: None,
        session_id,
        turn_id,
        status: if completed_at.is_some() {
            "complete"
        } else {
            "working"
        }
        .into(),
        started_at,
        completed_at,
        model,
        workspace,
        activity,
        context,
        evidence,
        artifacts,
    })
}

pub fn load_local_workstream(
    channel_id: &str,
    agent_pubkey: &str,
    agent_name: &str,
) -> Result<RuntimeWorkstreamPage, String> {
    uuid::Uuid::parse_str(channel_id).map_err(|_| "channel id must be a UUID".to_string())?;
    nostr::PublicKey::parse(agent_pubkey)
        .map_err(|_| "agent pubkey must be a valid Nostr public key".to_string())?;
    if agent_name.trim().is_empty() || agent_name.len() > 80 {
        return Err("agent name must contain 1 to 80 characters".to_string());
    }

    let root = sessions_root()?;
    let mut files = Vec::new();
    collect_jsonl_files(&root, 6, &mut files);
    files.sort_by_key(|path| std::cmp::Reverse(modified_at(path)));

    for path in files.into_iter().take(MAX_CANDIDATE_FILES) {
        let Ok(lines) = read_rollout(&path) else {
            continue;
        };
        if latest_trigger_matches(&lines, channel_id, agent_pubkey) {
            return parse_workstream(&lines, channel_id, agent_pubkey, agent_name);
        }
    }
    Err("no matching local agent runtime is active for this channel".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHANNEL: &str = "0b7c0958-3f7f-48c8-af3f-31e549b10e31";
    const AGENT: &str = "19215c80f8a71880f8c5738410d041e8afb2093bde1df8b4b691f23a50cb8b13";

    fn lines(input: &str) -> Vec<RolloutLine> {
        input
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|raw| RolloutLine {
                raw: raw.to_string(),
                value: serde_json::from_str(raw).expect("valid fixture line"),
            })
            .collect()
    }

    fn fixture(include_complete: bool) -> String {
        let complete = if include_complete {
            r#"{"timestamp":"2026-08-19T05:31:05Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-1","completed_at":"2026-08-19T05:31:05Z"}}"#
        } else {
            ""
        };
        format!(
            r#"{{"timestamp":"2026-08-19T05:30:00Z","type":"session_meta","payload":{{"session_id":"session-1"}}}}
{{"timestamp":"2026-08-19T05:31:00Z","type":"event_msg","payload":{{"type":"task_started","turn_id":"turn-1","started_at":"2026-08-19T05:31:00Z"}}}}
{{"timestamp":"2026-08-19T05:31:00Z","type":"turn_context","payload":{{"turn_id":"turn-1","cwd":"/workspace/project","workspace_roots":["/workspace"],"model":"gpt-test","summary":"private"}}}}
{{"timestamp":"2026-08-19T05:31:01Z","type":"event_msg","payload":{{"type":"user_message","message":"[Base]\nprivate base instructions\n[Agent Memory — core]\ntoken=private-memory\n[Context]\nchannel {CHANNEL} agent {AGENT}\n[Buzz event: @mention]\nContent: Show context safely; api_key=private-request\nTags: []\nParsed: mentions=[]"}}}}
{{"timestamp":"2026-08-19T05:31:02Z","type":"event_msg","payload":{{"type":"agent_reasoning","text":"**Planning test run**"}}}}
{{"timestamp":"2026-08-19T05:31:02Z","type":"response_item","payload":{{"type":"reasoning","summary":["private chain of thought"],"encrypted_content":"encrypted private reasoning"}}}}
{{"timestamp":"2026-08-19T05:31:02Z","type":"response_item","payload":{{"type":"custom_tool_call","call_id":"call-1","name":"exec","input":"await tools.exec_command({{cmd:\"echo secret=supersecret\"}}); await tools.apply_patch(\"secret\")"}}}}
{{"timestamp":"2026-08-19T05:31:03Z","type":"response_item","payload":{{"type":"custom_tool_call_output","call_id":"call-1","output":"[{{\"type\":\"input_text\",\"text\":\"Script completed\\nOutput:\\ntoken=do-not-show\"}}]"}}}}
{{"timestamp":"2026-08-19T05:31:04Z","type":"event_msg","payload":{{"type":"patch_apply_end","success":true,"changes":{{"/workspace/project/src/App.tsx":{{"type":"update","content":"private patch"}}}}}}}}
{{"timestamp":"2026-08-19T05:31:04Z","type":"event_msg","payload":{{"type":"agent_message","phase":"commentary","message":"Working now; token=do-not-show"}}}}
{complete}"#
        )
    }

    #[test]
    fn reduces_a_runtime_turn_without_leaking_private_fields() {
        let page = parse_workstream(&lines(&fixture(true)), CHANNEL, AGENT, "Lucas-Fizz")
            .expect("runtime page");
        let encoded = serde_json::to_string(&page).expect("encoded page");

        assert_eq!(page.status, "complete");
        assert_eq!(page.model, "gpt-test");
        assert!(page
            .activity
            .iter()
            .any(|event| event.title.starts_with("Ran echo")));
        assert!(page
            .activity
            .iter()
            .any(|event| event.title == "Thinking" && event.detail == "Planning test run"));
        assert!(page
            .activity
            .iter()
            .any(|event| event.title == "Files changed"));
        assert_eq!(page.artifacts[0].detail, "src/App.tsx");
        assert_eq!(page.context.len(), 5);
        let trigger = page
            .context
            .iter()
            .find(|source| source.label == "Triggering Buzz turn")
            .expect("trigger context");
        assert_eq!(
            trigger.content.as_deref(),
            Some("Show context safely; api_key=[redacted]")
        );
        let runtime = page
            .context
            .iter()
            .find(|source| source.kind == "repository")
            .expect("runtime context");
        assert!(runtime.fields.iter().any(|field| field.label == "Model"));
        let memory = page
            .context
            .iter()
            .find(|source| source.kind == "memory")
            .expect("memory context");
        assert!(memory.content.is_none());
        assert!(memory.withheld_reason.is_some());
        assert!(!encoded.contains("private chain of thought"));
        assert!(!encoded.contains("encrypted private reasoning"));
        assert!(!encoded.contains("private base instructions"));
        assert!(!encoded.contains("private-memory"));
        assert!(!encoded.contains("private-request"));
        assert!(!encoded.contains("nsec1notallowed"));
        assert!(!encoded.contains("do-not-show"));
        assert!(encoded.contains("token=[redacted]"));
    }

    #[test]
    fn reports_an_unfinished_turn_as_working() {
        let page = parse_workstream(&lines(&fixture(false)), CHANNEL, AGENT, "Lucas-Fizz")
            .expect("runtime page");
        assert_eq!(page.status, "working");
        assert!(page.completed_at.is_none());
    }

    #[test]
    fn requires_the_latest_trigger_to_match_the_target() {
        let mut fixture = fixture(false);
        fixture.push_str(
            "\n{\"timestamp\":\"2026-08-19T05:32:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"different channel\"}}",
        );
        let result = parse_workstream(&lines(&fixture), CHANNEL, AGENT, "Lucas-Fizz");
        assert!(result.is_err());
    }

    #[test]
    fn redacts_common_secret_shapes_and_private_sized_hex() {
        let visible = redact_visible(
            "api_key=abc123 nsec1abcdefghijk tskey-abcdefghijk 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        );
        assert!(!visible.contains("abc123"));
        assert!(!visible.contains("nsec1"));
        assert!(!visible.contains("tskey-"));
        assert!(!visible.contains("0123456789abcdef"));
    }

    #[test]
    #[ignore = "requires a matching live local Codex runtime"]
    fn live_runtime_probe_stays_inside_the_redacted_contract() {
        fn assert_no_private_keys(value: &Value) {
            match value {
                Value::Object(object) => {
                    for (key, nested) in object {
                        assert!(
                            !matches!(
                                key.as_str(),
                                "agent_reasoning"
                                    | "encrypted_content"
                                    | "token_count"
                                    | "rate_limits"
                                    | "custom_tool_call_output"
                            ),
                            "leaked field key: {key}"
                        );
                        assert_no_private_keys(nested);
                    }
                }
                Value::Array(values) => values.iter().for_each(assert_no_private_keys),
                _ => {}
            }
        }

        let channel = std::env::var("CONTROL_TOWER_LIVE_CHANNEL")
            .expect("CONTROL_TOWER_LIVE_CHANNEL is required");
        let agent = std::env::var("CONTROL_TOWER_LIVE_AGENT")
            .expect("CONTROL_TOWER_LIVE_AGENT is required");
        let page = load_local_workstream(&channel, &agent, "Live agent").expect("live runtime");
        let encoded = serde_json::to_value(&page).expect("encoded runtime page");

        assert!(!page.activity.is_empty());
        assert!(!page.turn_id.is_empty());
        assert_no_private_keys(&encoded);
    }
}
