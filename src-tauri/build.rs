use std::fs;
use std::path::Path;

fn main() {
    let api_host = std::env::var("PUBLIC_EXTERNAL_API_HOST")
        .unwrap_or_else(|_| "https://nhfguild.com".to_string());
    let api_host = api_host.trim_end_matches('/');

    if let Err(error) = patch_updater_endpoint(api_host) {
        println!("cargo:warning=Failed to patch updater endpoint: {error}");
    }

    tauri_build::build()
}

fn patch_updater_endpoint(api_host: &str) -> Result<(), Box<dyn std::error::Error>> {
    let config_path = Path::new("tauri.conf.json");
    let content = fs::read_to_string(config_path)?;
    let mut config: serde_json::Value = serde_json::from_str(&content)?;

    let endpoint = format!(
        "{api_host}/api/external/v1/releases/client/update/{{{{current_version}}}}"
    );

    let current = config
        .pointer("/plugins/updater/endpoints/0")
        .and_then(|value| value.as_str())
        .unwrap_or("");

    if current == endpoint {
        return Ok(());
    }

    if let Some(endpoints) = config
        .pointer_mut("/plugins/updater/endpoints")
        .and_then(|value| value.as_array_mut())
    {
        if endpoints.is_empty() {
            endpoints.push(serde_json::Value::String(endpoint.clone()));
        } else {
            endpoints[0] = serde_json::Value::String(endpoint);
        }
    }

    fs::write(config_path, serde_json::to_string_pretty(&config)? + "\n")?;
    Ok(())
}
