// Tabula desktop shell (TAB-100 spike): a window around the built web app, plus the glue that hands a `.drift` file
// the operating system asked us to open to the page. See docs/desktop.md.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{collections::HashSet, path::PathBuf, sync::Mutex};

use tauri::{ipc::Response, AppHandle, Emitter, Manager, State, Url};

/// Files the system asked us to open. `pending` is what the page has not collected yet; `granted` is every path the
/// page may read, so the read command cannot be used on arbitrary paths.
#[derive(Default)]
struct OpenedFiles {
  pending: Vec<PathBuf>,
  granted: HashSet<PathBuf>,
}

type Shared = Mutex<OpenedFiles>;

fn is_drift(path: &std::path::Path) -> bool {
  path.extension().is_some_and(|e| e.eq_ignore_ascii_case("drift"))
}

/// The `.drift` paths among command line arguments: how Windows and Linux pass a file at launch, and how a second
/// instance reports one on every platform. Flags and other arguments are ignored. Linux file managers can pass
/// `file://` URLs; other URLs are dropped and anything else is a path, so `C:\boards\a.drift` is not mistaken for a URL.
fn drift_paths<I: IntoIterator<Item = String>>(args: I) -> Vec<PathBuf> {
  args
    .into_iter()
    .filter(|a| !a.starts_with('-'))
    .filter_map(|a| {
      if a.get(..7).is_some_and(|scheme| scheme.eq_ignore_ascii_case("file://")) {
        Url::parse(&a).ok()?.to_file_path().ok()
      } else if a.contains("://") {
        None
      } else {
        Some(PathBuf::from(a))
      }
    })
    .filter(|p| is_drift(p))
    .collect()
}

fn receive(app: &AppHandle, paths: Vec<PathBuf>) {
  if paths.is_empty() {
    return;
  }
  {
    let state = app.state::<Shared>();
    let mut files = state.lock().unwrap();
    for path in paths {
      files.granted.insert(path.clone());
      files.pending.push(path);
    }
  }
  // The page may not be listening yet (cold start), so it also asks for `pending` once it is up.
  let _ = app.emit("opened-file", ());
}

/// Paths that arrived since the page last asked.
#[tauri::command]
fn take_opened_files(state: State<Shared>) -> Vec<String> {
  let paths = std::mem::take(&mut state.lock().unwrap().pending);
  paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// The bytes of a file the system handed us, for `readBoardFile` on the page.
#[tauri::command]
fn read_opened_file(path: String, state: State<Shared>) -> Result<Response, String> {
  let path = PathBuf::from(path);
  if !state.lock().unwrap().granted.contains(&path) {
    return Err("not a file the system asked this app to open".into());
  }
  std::fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

fn main() {
  let app = tauri::Builder::default()
    // Registered first, as the plugin requires. A second launch (Windows and Linux open each double-clicked file in a
    // new process) ends here and reports its arguments to the running instance.
    .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
      receive(app, drift_paths(args.into_iter().skip(1)));
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
      }
    }))
    .manage(Shared::default())
    .invoke_handler(tauri::generate_handler![take_opened_files, read_opened_file])
    .setup(|#[allow(unused_variables)] app| {
      #[cfg(any(windows, target_os = "linux"))]
      receive(app.handle(), drift_paths(std::env::args().skip(1)));
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building Tabula");

  app.run(|#[allow(unused_variables)] app, #[allow(unused_variables)] event| {
    // macOS never passes the file as an argument: LaunchServices sends an open event, at launch or to the running app.
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Opened { urls } = event {
      receive(app, urls.into_iter().filter_map(|u| u.to_file_path().ok()).filter(|p| is_drift(p)).collect());
    }
  });
}

#[cfg(test)]
mod tests {
  use super::*;

  fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
  }

  #[test]
  fn keeps_only_drift_paths() {
    let got = drift_paths(args(&["--flag", "notes.txt", "/tmp/a.drift", "/tmp/B.DRIFT", "/tmp/board.json"]));
    assert_eq!(got, vec![PathBuf::from("/tmp/a.drift"), PathBuf::from("/tmp/B.DRIFT")]);
  }

  #[test]
  fn windows_paths_are_not_urls() {
    let got = drift_paths(args(&[r"C:\Users\ann\boards\retro.drift"]));
    assert_eq!(got, vec![PathBuf::from(r"C:\Users\ann\boards\retro.drift")]);
  }

  #[test]
  #[cfg(unix)]
  fn file_urls_are_decoded() {
    let got = drift_paths(args(&["file:///tmp/my%20board.drift", "https://example.com/a.drift"]));
    assert_eq!(got, vec![PathBuf::from("/tmp/my board.drift")]);
  }
}
