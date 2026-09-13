export type ToastType = "error" | "warning" | "info" | "success";

export interface ToastEvent {
  message: string;
  type: ToastType;
}

const TOAST_EVENT = "kf-toast";

export function showToast(message: string, type: ToastType = "error") {
  window.dispatchEvent(new CustomEvent<ToastEvent>(TOAST_EVENT, { detail: { message, type } }));
}

export { TOAST_EVENT };
