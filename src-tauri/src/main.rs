mod backend;
mod notifications;

use backend::{Session, Status, Supervisor, Supplier};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    tray::TrayIconBuilder,
    webview::NewWindowResponse,
    ActivationPolicy, AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const MAIN: &str = "main";

#[derive(Default)]
struct Page {
    session: Option<Session>,
    pending: Option<Supplier>,
}

struct Desktop {
    page: Mutex<Page>,
    supervisor: Supervisor,
    quitting: AtomicBool,
    exited: AtomicBool,
}

fn shell_url() -> Url {
    Url::parse("tauri://localhost/index.html").expect("valid shell URL")
}

fn allowed(app: &AppHandle, url: &Url) -> bool {
    let shell = shell_url();
    if url.scheme() == shell.scheme()
        && url.host_str() == shell.host_str()
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && matches!(url.path(), "/" | "/index.html")
    {
        return true;
    }
    app.state::<Desktop>()
        .page
        .lock()
        .unwrap()
        .session
        .as_ref()
        .is_some_and(|session| session.allows(url))
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn open_window(app: &AppHandle) {
    if let Some(window) = window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn focus_supplier(app: &AppHandle, supplier: Supplier) {
    let state = app.state::<Desktop>();
    if state.quitting.load(Ordering::Acquire) {
        return;
    }
    let url = {
        let mut page = state.page.lock().unwrap();
        match &page.session {
            Some(session) => Some(session.url(Some(supplier))),
            None => {
                page.pending = Some(supplier);
                None
            }
        }
    };
    if let (Some(window), Some(url)) = (window(app), url) {
        let _ = window.navigate(url);
    }
    open_window(app);
}

fn update_window(app: &AppHandle, status: Status) {
    let state = app.state::<Desktop>();
    if state.quitting.load(Ordering::Acquire) {
        return;
    }
    match status {
        Status::Starting => {
            state.page.lock().unwrap().session = None;
            if let Some(window) = window(app) {
                let _ = window.navigate(shell_url());
            }
        }
        Status::Ready(session) => {
            let url = {
                let mut page = state.page.lock().unwrap();
                let target = session.url(page.pending.take());
                page.session = Some(session);
                target
            };
            if let Some(window) = window(app) {
                let _ = window.navigate(url);
            }
        }
        Status::Failed(message) => {
            state.page.lock().unwrap().session = None;
            let mut url = shell_url();
            url.query_pairs_mut().append_pair("status", &message);
            if let Some(window) = window(app) {
                let _ = window.navigate(url);
            }
        }
        Status::Alert {
            id,
            supplier,
            message,
        } => notifications::send(id, supplier, message),
        Status::Stopped => {}
    }
}

fn build_menus(app: &AppHandle) -> tauri::Result<()> {
    let tray_menu = MenuBuilder::new(app)
        .text("open", "打开 Clash Pro")
        .text("retry", "重试启动本机服务")
        .separator()
        .text("quit", "退出 Clash Pro")
        .build()?;
    TrayIconBuilder::with_id("clash-pro")
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("Clash Pro")
        .menu(&tray_menu)
        .show_menu_on_left_click(true)
        .build(app)?;

    let quit = MenuItemBuilder::with_id("quit", "退出 Clash Pro")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Clash Pro").item(&quit).build()?;
    let edit = SubmenuBuilder::new(app, "编辑")
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    app.set_menu(MenuBuilder::new(app).item(&app_menu).item(&edit).build()?)?;
    Ok(())
}

fn handle_menu(app: &AppHandle, item: &str) {
    match item {
        "open" => open_window(app),
        "retry" => {
            open_window(app);
            let state = app.state::<Desktop>();
            if !state.quitting.load(Ordering::Acquire) {
                state.supervisor.start();
            }
        }
        "quit" => app.exit(0),
        _ => {}
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            open_window(app)
        }))
        .setup(|app| {
            let handle = app.handle().clone();
            handle.set_activation_policy(ActivationPolicy::Accessory)?;
            let backend = handle.path().resource_dir()?.join("backend");
            let runner = Supervisor::new(backend, {
                let handle = handle.clone();
                move |status| {
                    if matches!(status, Status::Stopped) {
                        handle
                            .state::<Desktop>()
                            .exited
                            .store(true, Ordering::Release);
                        handle.exit(0);
                    } else {
                        let callback = handle.clone();
                        let _ = handle.run_on_main_thread(move || update_window(&callback, status));
                    }
                }
            });
            handle.manage(Desktop {
                page: Mutex::new(Page::default()),
                supervisor: runner.clone(),
                quitting: AtomicBool::new(false),
                exited: AtomicBool::new(false),
            });
            let policy = handle.clone();
            WebviewWindowBuilder::new(&handle, MAIN, WebviewUrl::App("index.html".into()))
                .title("Clash Pro")
                .inner_size(980.0, 720.0)
                .min_inner_size(500.0, 460.0)
                .center()
                .incognito(true)
                .on_navigation(move |url| allowed(&policy, url))
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            build_menus(&handle)?;
            notifications::install(&handle);
            open_window(&handle);
            runner.start();
            Ok(())
        })
        .on_menu_event(|app, event| handle_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if window.label() == MAIN
                    && !app.state::<Desktop>().quitting.load(Ordering::Acquire)
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("could not build Clash Pro");
    app.run(|app, event| match event {
        RunEvent::Reopen { .. } => open_window(app),
        RunEvent::ExitRequested { api, .. } => {
            if let Some(state) = app.try_state::<Desktop>() {
                if !state.exited.load(Ordering::Acquire) {
                    api.prevent_exit();
                    if !state.quitting.swap(true, Ordering::AcqRel) && !state.supervisor.shutdown()
                    {
                        state.exited.store(true, Ordering::Release);
                        let app = app.clone();
                        std::thread::spawn(move || app.exit(0));
                    }
                }
            }
        }
        _ => {}
    });
}
