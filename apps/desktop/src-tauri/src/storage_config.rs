//! Configuración de almacenamiento del desktop: modo local/cloud y base URL
//! de la API. Vive en appdata junto al snapshot local y sobrevive reinicios.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const CONFIG_FILE: &str = "storage.json";
const CONFIG_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StorageMode {
    Local,
    Cloud,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageConfig {
    #[serde(default = "current_version")]
    pub version: u32,
    pub mode: StorageMode,
    pub api_base_url: String,
    #[serde(default)]
    pub onboarding_complete: bool,
}

fn current_version() -> u32 {
    CONFIG_VERSION
}

impl StorageConfig {
    /// Default seguro: local, onboarding pendiente y la API del relay.
    pub fn local(default_api_base_url: &str) -> Self {
        Self {
            version: CONFIG_VERSION,
            mode: StorageMode::Local,
            api_base_url: default_api_base_url.to_string(),
            onboarding_complete: false,
        }
    }

    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join(CONFIG_FILE)
    }

    /// Lee la configuración. Archivo ausente, ilegible, de otra versión o con
    /// una URL inválida cae al default local: nunca impide arrancar.
    pub fn load(data_dir: &Path, default_api_base_url: &str) -> Self {
        let fallback = Self::local(default_api_base_url);
        let Ok(raw) = fs::read_to_string(Self::path(data_dir)) else {
            return fallback;
        };
        let Ok(mut config) = serde_json::from_str::<Self>(&raw) else {
            return fallback;
        };
        if config.version != CONFIG_VERSION {
            return fallback;
        }
        match normalize_api_base_url(&config.api_base_url) {
            Ok(url) => config.api_base_url = url,
            Err(_) => config.api_base_url = fallback.api_base_url,
        }
        config
    }

    /// Valida y normaliza los campos editables. El modo cloud requiere una
    /// base URL http(s) absoluta; el valor se guarda sin barra final.
    pub fn validate(&mut self) -> Result<(), String> {
        self.api_base_url = normalize_api_base_url(&self.api_base_url)?;
        self.version = CONFIG_VERSION;
        Ok(())
    }

    /// Persiste la configuración de forma atómica (tmp + rename). El
    /// `onboarding_complete` lo decide quien llama y ya viene validado.
    pub fn save(&self, data_dir: &Path) -> Result<(), String> {
        fs::create_dir_all(data_dir)
            .map_err(|e| format!("no se pudo crear el directorio de datos: {e}"))?;
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("no se pudo serializar la configuración: {e}"))?;
        let path = Self::path(data_dir);
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| format!("no se pudo escribir la configuración: {e}"))?;
        fs::rename(&tmp, &path).map_err(|e| format!("no se pudo reemplazar la configuración: {e}"))
    }
}

fn normalize_api_base_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    let rest = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .ok_or_else(|| "la URL de la API debe empezar con http:// o https://".to_string())?;
    if rest.is_empty() || rest.chars().any(char::is_whitespace) {
        return Err("la URL de la API no es válida".to_string());
    }
    if trimmed.contains(['?', '#']) {
        return Err("la URL de la API no puede tener query ni fragmento".to_string());
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static N: AtomicU64 = AtomicU64::new(0);
            let n = N.fetch_add(1, Ordering::SeqCst);
            let path = std::env::temp_dir().join(format!(
                "opencollab-storage-config-{tag}-{}-{n}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn default_url() -> &'static str {
        "http://127.0.0.1:8787"
    }

    #[test]
    fn missing_file_is_local_and_pending_onboarding() {
        let dir = TempDir::new("missing");
        let config = StorageConfig::load(&dir.0, default_url());
        assert_eq!(config.mode, StorageMode::Local);
        assert_eq!(config.api_base_url, default_url());
        assert!(!config.onboarding_complete);
    }

    #[test]
    fn round_trips_the_storage_config() {
        let dir = TempDir::new("roundtrip");
        let mut config = StorageConfig {
            version: CONFIG_VERSION,
            mode: StorageMode::Cloud,
            api_base_url: "https://api.example.com/".into(),
            onboarding_complete: true,
        };
        config.validate().unwrap();
        config.save(&dir.0).unwrap();
        assert_eq!(StorageConfig::load(&dir.0, default_url()), config);
    }

    #[test]
    fn malformed_or_future_config_falls_back_to_local() {
        let dir = TempDir::new("malformed");
        fs::write(StorageConfig::path(&dir.0), "not json").unwrap();
        let malformed = StorageConfig::load(&dir.0, default_url());
        assert_eq!(malformed.mode, StorageMode::Local);
        assert!(!malformed.onboarding_complete);

        fs::write(
            StorageConfig::path(&dir.0),
            r#"{"version":99,"mode":"cloud","apiBaseUrl":"https://api.example.com","onboardingComplete":true}"#,
        )
        .unwrap();
        let future = StorageConfig::load(&dir.0, default_url());
        assert_eq!(future.mode, StorageMode::Local);
        assert_eq!(future.api_base_url, default_url());
    }

    #[test]
    fn invalid_api_base_url_falls_back_to_the_relay_default() {
        let dir = TempDir::new("invalid");
        fs::write(
            StorageConfig::path(&dir.0),
            r#"{"version":1,"mode":"cloud","apiBaseUrl":"not-a-url","onboardingComplete":true}"#,
        )
        .unwrap();
        let config = StorageConfig::load(&dir.0, default_url());
        assert_eq!(config.mode, StorageMode::Cloud);
        assert_eq!(config.api_base_url, default_url());
    }

    #[test]
    fn validates_and_normalizes_the_api_base_url() {
        let mut config = StorageConfig {
            version: 1,
            mode: StorageMode::Cloud,
            api_base_url: "  https://api.example.com/  ".into(),
            onboarding_complete: false,
        };
        config.validate().unwrap();
        assert_eq!(config.api_base_url, "https://api.example.com");
        assert_eq!(config.version, CONFIG_VERSION);

        config.api_base_url = "ftp://api.example.com".into();
        assert!(config.validate().is_err());
        config.api_base_url = "http://".into();
        assert!(config.validate().is_err());
        config.api_base_url = "http://api.example.com?token=1".into();
        assert!(config.validate().is_err());
    }
}
