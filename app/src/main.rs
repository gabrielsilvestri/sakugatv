// SakugaTV: native window (Windows WebView2) around the local server.
// Starts the server if it isn't running and stops it on close, if this window started it.
#![windows_subsystem = "windows"]

use std::net::TcpStream;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::{Duration, Instant};

use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::platform::windows::WindowBuilderExtWindows;
use tao::window::{Fullscreen, Icon, WindowBuilder};
use wry::{NewWindowResponse, WebContext, WebViewBuilder, WebViewBuilderExtWindows};

const PORT: u16 = 8765;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn server_up() -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], PORT).into(), Duration::from_millis(300)).is_ok()
}

fn project_dir() -> PathBuf {
    // the exe lives in app/target/release; the project root is the parent of app
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn start_server() -> Option<Child> {
    if server_up() {
        return None;
    }
    let child = Command::new("node")
        .arg("server.mjs")
        .current_dir(project_dir())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .ok();
    let t = Instant::now();
    while !server_up() && t.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(150));
    }
    child
}

fn icon() -> Option<Icon> {
    let img = image::load_from_memory(include_bytes!("../../raycast/assets/icon.png")).ok()?.into_rgba8();
    let (w, h) = img.dimensions();
    Icon::from_rgba(img.into_raw(), w, h).ok()
}

fn open_in_browser(url: &str) {
    let _ = Command::new("cmd").args(["/c", "start", "", url]).creation_flags(CREATE_NO_WINDOW).spawn();
}

#[link(name = "user32")]
unsafe extern "system" {
    fn FindWindowW(class: *const u16, title: *const u16) -> isize;
    fn SetForegroundWindow(hwnd: isize) -> i32;
    fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
}

// opening again brings the existing window to the front instead of creating another
fn focus_existing() -> bool {
    let title: Vec<u16> = "SakugaTV".encode_utf16().chain(Some(0)).collect();
    let hwnd = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
    if hwnd == 0 {
        return false;
    }
    unsafe {
        ShowWindow(hwnd, 9); // SW_RESTORE
        SetForegroundWindow(hwnd);
    }
    true
}

enum UserEvent {
    Fullscreen(bool),
    Drag,
    Minimize,
    ToggleMaximize,
    Close,
    OnTop(bool),
}

fn main() -> wry::Result<()> {
    if focus_existing() {
        return Ok(());
    }
    // leave the exe path where the Raycast command can find it
    if let (Ok(exe), Ok(dir)) = (std::env::current_exe(), std::env::var("LOCALAPPDATA")) {
        let dir = PathBuf::from(dir).join("SakugaTV");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("app-path.txt"), exe.to_string_lossy().as_bytes());
    }
    let mut server = start_server();

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let window = WindowBuilder::new()
        .with_title("SakugaTV")
        .with_inner_size(LogicalSize::new(1440.0, 900.0))
        .with_min_inner_size(LogicalSize::new(720.0, 480.0))
        .with_window_icon(icon())
        // no Windows frame: the title bar is drawn by the page
        .with_decorations(false)
        .with_undecorated_shadow(true)
        .build(&event_loop)
        .expect("janela");

    // fit the screen: at most 1440x900, never more than 90% of the monitor, centered
    if let Some(mon) = window.current_monitor() {
        let scale = mon.scale_factor();
        let area = mon.size().to_logical::<f64>(scale);
        let (w, h) = ((area.width * 0.9).min(1440.0), (area.height * 0.88).min(900.0));
        window.set_inner_size(LogicalSize::new(w, h));
        let pos = mon.position().to_logical::<f64>(scale);
        window.set_outer_position(tao::dpi::LogicalPosition::new(pos.x + (area.width - w) / 2.0, pos.y + (area.height - h) / 2.0 - 16.0));
    }

    let data = std::env::var("LOCALAPPDATA").map(|d| PathBuf::from(d).join("SakugaTV")).ok();
    let mut ctx = WebContext::new(data);
    let webview = WebViewBuilder::new_with_web_context(&mut ctx)
        .with_url(format!("http://localhost:{PORT}/"))
        .with_background_color((14, 17, 22, 255))
        .with_additional_browser_args("--autoplay-policy=no-user-gesture-required --disable-features=msSmartScreenProtection")
        .with_ipc_handler(move |req| {
            let ev = match req.body().as_str() {
                "fullscreen:on" => UserEvent::Fullscreen(true),
                "fullscreen:off" => UserEvent::Fullscreen(false),
                "drag" => UserEvent::Drag,
                "min" => UserEvent::Minimize,
                "max" => UserEvent::ToggleMaximize,
                "close" => UserEvent::Close,
                "top:on" => UserEvent::OnTop(true),
                "top:off" => UserEvent::OnTop(false),
                _ => return,
            };
            let _ = proxy.send_event(ev);
        })
        // links to Sakugabooru open in the browser, not inside the app
        .with_new_window_req_handler(|url, _| {
            open_in_browser(&url);
            NewWindowResponse::Deny
        })
        .build(&window)?;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        let _ = &webview;
        match event {
            Event::UserEvent(UserEvent::Fullscreen(on)) => {
                window.set_fullscreen(if on { Some(Fullscreen::Borderless(None)) } else { None });
            }
            Event::UserEvent(UserEvent::Drag) => {
                let _ = window.drag_window();
            }
            Event::UserEvent(UserEvent::Minimize) => window.set_minimized(true),
            Event::UserEvent(UserEvent::OnTop(on)) => window.set_always_on_top(on),
            Event::UserEvent(UserEvent::ToggleMaximize) => window.set_maximized(!window.is_maximized()),
            Event::UserEvent(UserEvent::Close) | Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                if let Some(child) = server.as_mut() {
                    let _ = child.kill();
                }
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}
