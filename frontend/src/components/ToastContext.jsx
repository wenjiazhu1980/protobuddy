import { createContext, useContext, useState, useCallback, useRef } from 'react';

/**
 * 全局 Toast：支持堆叠，API 与原各页 showToast(msg, type) 完全兼容。
 * 退场动画：toastOut 0.18s 后从 DOM 移除。
 */
const ToastContext = createContext(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);

  const remove = useCallback((id) => {
    setToasts((list) => list.map((t) => t.id === id ? { ...t, leaving: true } : t));
    setTimeout(() => {
      setToasts((list) => list.filter((t) => t.id !== id));
    }, 200);
  }, []);

  const showToast = useCallback((message, type = 'success') => {
    const id = ++seq.current;
    setToasts((list) => [...list, { id, message, type }]);
    setTimeout(() => remove(id), 3000);
  }, [remove]);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.type}${t.leaving ? ' leaving' : ''}`}
            onClick={() => remove(t.id)}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
