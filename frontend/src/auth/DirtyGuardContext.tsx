import React, { createContext, useContext, useRef, useCallback } from 'react';

/**
 * DirtyGuardContext allows any page to register a "dirty check" callback.
 * The callback returns true if there are unsaved changes that should block
 * navigation. Nav links check this before following their href.
 */

type DirtyCheckFn = () => boolean;

interface DirtyGuardCtx {
  register:   (fn: DirtyCheckFn) => void;
  unregister: () => void;
  isDirty:    () => boolean;
}

const DirtyGuardContext = createContext<DirtyGuardCtx>({
  register:   () => {},
  unregister: () => {},
  isDirty:    () => false,
});

export const DirtyGuardProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const checkRef = useRef<DirtyCheckFn | null>(null);

  const register   = useCallback((fn: DirtyCheckFn) => { checkRef.current = fn; }, []);
  const unregister = useCallback(() => { checkRef.current = null; }, []);
  const isDirty    = useCallback(() => checkRef.current?.() ?? false, []);

  return (
    <DirtyGuardContext.Provider value={{ register, unregister, isDirty }}>
      {children}
    </DirtyGuardContext.Provider>
  );
};

export const useDirtyGuard = () => useContext(DirtyGuardContext);
