import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { PromptDialog } from './PromptDialog';
import { ChooseDialog, type ChooseDialogAction } from './ChooseDialog';

export interface PopupConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface PopupAlertOptions {
  title: string;
  message: ReactNode;
  okLabel?: string;
  danger?: boolean;
}

export interface PopupPromptOptions {
  title: string;
  message: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  multiline?: boolean;
  danger?: boolean;
}

export interface PopupChooseOptions<T extends string = string> {
  title: string;
  message: ReactNode;
  options: ReadonlyArray<{ key: T; label: string; tone?: 'primary' | 'secondary' | 'danger' }>;
}

type ConfirmRequest = {
  kind: 'confirm';
  options: PopupConfirmOptions;
  resolve: (value: boolean) => void;
};

type AlertRequest = {
  kind: 'alert';
  options: PopupAlertOptions;
  resolve: () => void;
};

type PromptRequest = {
  kind: 'prompt';
  options: PopupPromptOptions;
  resolve: (value: string | null) => void;
};

type ChooseRequest = {
  kind: 'choose';
  options: PopupChooseOptions;
  resolve: (value: string | null) => void;
};

type PopupRequest = ConfirmRequest | AlertRequest | PromptRequest | ChooseRequest;

export interface PopupContextValue {
  confirm: (options: PopupConfirmOptions) => Promise<boolean>;
  alert: (options: PopupAlertOptions) => Promise<void>;
  prompt: (options: PopupPromptOptions) => Promise<string | null>;
  choose: <T extends string = string>(options: PopupChooseOptions<T>) => Promise<T | null>;
}

const PopupContext = createContext<PopupContextValue | null>(null);

interface PopupProviderProps {
  children: ReactNode;
}

export function PopupProvider({ children }: PopupProviderProps) {
  const [queue, setQueue] = useState<PopupRequest[]>([]);

  const activeRequest = queue.length > 0 ? queue[0] : null;

  const enqueueRequest = useCallback((request: PopupRequest) => {
    setQueue((prev) => [...prev, request]);
  }, []);

  const dequeueRequest = useCallback(() => {
    setQueue((prev) => prev.slice(1));
  }, []);

  const confirm = useCallback(
    (options: PopupConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        enqueueRequest({
          kind: 'confirm',
          options,
          resolve,
        });
      }),
    [enqueueRequest]
  );

  const alert = useCallback(
    (options: PopupAlertOptions) =>
      new Promise<void>((resolve) => {
        enqueueRequest({
          kind: 'alert',
          options,
          resolve,
        });
      }),
    [enqueueRequest]
  );

  const prompt = useCallback(
    (options: PopupPromptOptions) =>
      new Promise<string | null>((resolve) => {
        enqueueRequest({
          kind: 'prompt',
          options,
          resolve,
        });
      }),
    [enqueueRequest]
  );

  const choose = useCallback(
    <T extends string = string>(options: PopupChooseOptions<T>) =>
      new Promise<T | null>((resolve) => {
        enqueueRequest({
          kind: 'choose',
          options: options as PopupChooseOptions,
          resolve: resolve as (value: string | null) => void,
        });
      }),
    [enqueueRequest]
  );

  const resolveActive = useCallback(
    (didConfirm: boolean, promptValue?: string) => {
      if (!activeRequest) return;

      if (activeRequest.kind === 'confirm') {
        activeRequest.resolve(didConfirm);
      } else if (activeRequest.kind === 'prompt') {
        activeRequest.resolve(didConfirm ? (promptValue ?? '') : null);
      } else if (activeRequest.kind === 'choose') {
        // resolveActive only handles cancel for choose; selection uses resolveChoose.
        activeRequest.resolve(null);
      } else {
        activeRequest.resolve();
      }

      dequeueRequest();
    },
    [activeRequest, dequeueRequest]
  );

  const resolveChoose = useCallback(
    (key: string) => {
      if (!activeRequest || activeRequest.kind !== 'choose') return;
      activeRequest.resolve(key);
      dequeueRequest();
    },
    [activeRequest, dequeueRequest]
  );

  const contextValue = useMemo<PopupContextValue>(
    () => ({
      confirm,
      alert,
      prompt,
      choose,
    }),
    [confirm, alert, prompt, choose]
  );

  const title = activeRequest?.options.title || '';
  const message = activeRequest && 'message' in activeRequest.options
    ? (activeRequest.options as { message: ReactNode }).message ?? ''
    : '';
  const danger = activeRequest && 'danger' in activeRequest.options
    ? Boolean((activeRequest.options as { danger?: boolean }).danger)
    : false;
  const isConfirm = activeRequest?.kind === 'confirm';
  const isPrompt = activeRequest?.kind === 'prompt';
  const isChoose = activeRequest?.kind === 'choose';
  const chooseActions: ChooseDialogAction[] = isChoose
    ? (activeRequest as ChooseRequest).options.options.map((o) => ({
        key: o.key,
        label: o.label,
        tone: o.tone,
      }))
    : [];
  const confirmLabel = isConfirm
    ? (activeRequest as ConfirmRequest).options.confirmLabel || 'Confirm'
    : isPrompt
      ? (activeRequest as PromptRequest).options.confirmLabel || 'Confirm'
      : activeRequest?.kind === 'alert'
        ? (activeRequest as AlertRequest).options.okLabel || 'OK'
        : 'OK';
  const cancelLabel = isConfirm
    ? (activeRequest as ConfirmRequest).options.cancelLabel || 'Cancel'
    : 'Close';

  return (
    <PopupContext.Provider value={contextValue}>
      {children}
      {isPrompt ? (
        <PromptDialog
          isOpen
          title={title}
          message={typeof message === 'string' ? message : ''}
          initialValue={(activeRequest as PromptRequest).options.initialValue}
          placeholder={(activeRequest as PromptRequest).options.placeholder}
          multiline={Boolean((activeRequest as PromptRequest).options.multiline)}
          confirmLabel={confirmLabel}
          cancelLabel={(activeRequest as PromptRequest).options.cancelLabel || 'Cancel'}
          danger={danger}
          onConfirm={(value) => resolveActive(true, value)}
          onCancel={() => resolveActive(false)}
        />
      ) : isChoose ? (
        <ChooseDialog
          isOpen
          title={title}
          message={message}
          actions={chooseActions}
          onSelect={resolveChoose}
          onCancel={() => resolveActive(false)}
        />
      ) : (
        <ConfirmDialog
          isOpen={Boolean(activeRequest)}
          title={title}
          message={message}
          confirmLabel={confirmLabel}
          cancelLabel={cancelLabel}
          showCancel={Boolean(isConfirm)}
          danger={danger}
          onConfirm={() => resolveActive(true)}
          onCancel={() => resolveActive(false)}
        />
      )}
    </PopupContext.Provider>
  );
}

export function usePopup() {
  const context = useContext(PopupContext);
  if (!context) {
    throw new Error('usePopup must be used within a PopupProvider');
  }
  return context;
}
