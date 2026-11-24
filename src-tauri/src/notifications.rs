#![allow(non_snake_case)] // Objective-C protocol methods use the generated Rust names.

use crate::backend::Supplier;
use block2::{DynBlock, RcBlock};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{NSObject, NSObjectProtocol, ProtocolObject},
    ClassType,
};
use objc2_foundation::{NSDictionary, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSettings, UNNotificationSound,
    UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::{cell::OnceCell, ptr::NonNull, sync::OnceLock};
use tauri::AppHandle;

static APP: OnceLock<AppHandle> = OnceLock::new();
thread_local! { static DELEGATE: OnceCell<Retained<Delegate>> = const { OnceCell::new() }; }

define_class!(
    // The notification center holds a weak reference; DELEGATE owns it on the main thread.
    #[unsafe(super(NSObject))]
    #[name = "ClashProNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn userNotificationCenter_willPresentNotification_withCompletionHandler(
            &self,
            _: &UNUserNotificationCenter,
            _: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn userNotificationCenter_didReceiveNotificationResponse_withCompletionHandler(
            &self,
            _: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            if *response.actionIdentifier() == *unsafe { UNNotificationDefaultActionIdentifier } {
                let info = response.notification().request().content().userInfo();
                let key = NSString::from_str("supplier");
                let value = info
                    .objectForKey(&key)
                    .and_then(|value| value.downcast::<NSString>().ok());
                let supplier = value
                    .as_deref()
                    .and_then(|value| Supplier::try_from(value.to_string()).ok());
                if let (Some(app), Some(supplier)) = (APP.get(), supplier) {
                    let handle = app.clone();
                    let _ =
                        app.run_on_main_thread(move || crate::focus_supplier(&handle, supplier));
                }
            }
            completion.call(());
        }
    }
);

pub fn install(app: &AppHandle) {
    let _ = APP.set(app.clone());
    DELEGATE.with(|cell| {
        let delegate = cell.get_or_init(|| unsafe { msg_send![Delegate::class(), new] });
        UNUserNotificationCenter::currentNotificationCenter()
            .setDelegate(Some(ProtocolObject::from_ref(&**delegate)));
    });
}

fn deliver(id: &str, supplier: &Supplier, message: &str) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str("Clash Pro"));
    content.setBody(&NSString::from_str(message));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let key = NSString::from_str("supplier");
    let value = NSString::from_str(supplier.label());
    let info = NSDictionary::from_slices(&[&*key], &[&*value]);
    // UserNotifications accepts a dictionary of property-list keys and values.
    unsafe { content.setUserInfo(&Retained::cast_unchecked::<NSDictionary>(info)) };
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &NSString::from_str(id),
        &content,
        None,
    );
    UNUserNotificationCenter::currentNotificationCenter()
        .addNotificationRequest_withCompletionHandler(&request, None);
}

pub fn send(id: String, supplier: Supplier, message: String) {
    let decide = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        let status = unsafe { settings.as_ref() }.authorizationStatus();
        if status == UNAuthorizationStatus::Authorized
            || status == UNAuthorizationStatus::Provisional
        {
            deliver(&id, &supplier, &message);
        } else if status == UNAuthorizationStatus::NotDetermined {
            let (id, supplier, message) = (id.clone(), supplier.clone(), message.clone());
            let authorized = RcBlock::new(move |granted: objc2::runtime::Bool, _| {
                if granted.as_bool() {
                    deliver(&id, &supplier, &message);
                }
            });
            UNUserNotificationCenter::currentNotificationCenter()
                .requestAuthorizationWithOptions_completionHandler(
                    UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
                    &authorized,
                );
        }
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .getNotificationSettingsWithCompletionHandler(&decide);
}
