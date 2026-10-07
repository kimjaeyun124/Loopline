import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  createRemoteRun,
  getRemoteRun,
  getRemoteStatus,
  normalizeTailscaleBaseUrl,
  RemoteApiError,
  resumeRemoteRun,
  startRemoteChatStream,
  stopRemoteRun,
  TERMINAL_REMOTE_RUN_STATES,
} from './src/remoteApi';
import type {RemoteRun, RemoteStatus} from './src/remoteApi';
import type {ModelChoice} from './src/types';

const SETTINGS_KEY = 'loopline.ios.settings.v1';
const CHAT_KEY = 'loopline.ios.chat.v1';
const RUN_KEY = 'loopline.ios.run.v1';
const ROUND_OPTIONS = [0, 1, 2, 3, 5, 8];
const COLORS = {
  background: '#111315',
  surface: '#1a1d20',
  surfaceRaised: '#22262a',
  border: '#30363b',
  text: '#f1f3f4',
  muted: '#a0a7ad',
  dim: '#737c84',
  accent: '#8dbbff',
  green: '#7ccea1',
  red: '#ff9298',
  amber: '#f2c67d',
};

type ChatItem = {id: string; role: 'user' | 'assistant'; content: string; error?: boolean};
type RoleName = 'chat' | 'planner' | 'worker' | 'judge';
type RoleSelection = {planner: string; worker: string; judge: string};
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'offline';

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function roleName(role: RoleName): string {
  return ({chat: '대화 모델', planner: '계획', worker: '구현', judge: '판정'} as const)[role];
}

function modelName(model?: ModelChoice): string {
  return model ? `${model.providerLabel} · ${model.label}` : '모델 선택';
}

function statusLabel(status?: string): string {
  return ({
    running: '진행 중', stopping: '중지 중', completed: '완료', reviewed: '검토 필요',
    stopped: '중지됨', failed: '실패', limit: '회차 한도', blocked: '확인 필요', interrupted: '중단됨',
  } as Record<string, string>)[status || ''] || '상태 확인 중';
}

function stageLabel(stage?: string): string {
  return ({
    prepare: '작업 공간 준비', configuring: '프로젝트 설정', selecting: '모델 배정', planning: '계획', planner: '계획',
    working: '구현', implement: '구현', worker: '구현', 'milestone-qa': '부분 검증', verifying: '검증',
    verify: '검증', judging: '판정', judge: '판정', applying: '변경 반영', apply: '변경 반영',
    'browser-qa': '브라우저 QA', finished: '마무리', finish: '마무리', done: '완료',
  } as Record<string, string>)[stage || ''] || 'Loop 작업';
}

export default function PhoneApp() {
  const [hydrated, setHydrated] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [settingsValue, setSettingsValue] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [tab, setTab] = useState<'chat' | 'loop'>('loop');
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === 'active');
  const [chatItems, setChatItems] = useState<ChatItem[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatModelKey, setChatModelKey] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [taskInput, setTaskInput] = useState('');
  const [roles, setRoles] = useState<RoleSelection>({planner: '', worker: '', judge: ''});
  const [rounds, setRounds] = useState(3);
  const [run, setRun] = useState<RemoteRun | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState('');
  const [rolePicker, setRolePicker] = useState<RoleName | null>(null);
  const [expandedEventId, setExpandedEventId] = useState('');

  const chatScrollRef = useRef<ScrollView>(null);
  const streamRef = useRef<{requestId: number; assistantItemId: string; baseUrl: string; abort: () => void} | null>(null);
  const chatRequestSequenceRef = useRef(0);
  const runRequestSequenceRef = useRef(0);
  const runRequestsInFlightRef = useRef(new Map<string, number>());
  const statusRequestRef = useRef(0);

  const invalidateRunRefresh = () => {
    runRequestSequenceRef.current += 1;
  };

  const models = status?.models || [];
  const workingModels = useMemo(() => models.filter(model => !model.decisionOnly), [models]);
  const currentChatModel = models.find(model => model.key === chatModelKey);
  const roleModel = (role: Exclude<RoleName, 'chat'>) => models.find(model => model.key === roles[role]);
  const normalizedUrl = useMemo(() => {
    try { return serverUrl ? normalizeTailscaleBaseUrl(serverUrl) : ''; } catch { return ''; }
  }, [serverUrl]);
  const canStartLoop = connection === 'connected' && Boolean(taskInput.trim())
    && Boolean(roles.planner && roles.worker && roles.judge) && !runBusy
    && (!run || TERMINAL_REMOTE_RUN_STATES.has(run.status));

  const refreshRun = useCallback(async (baseUrl: string, runId: string) => {
    const requestKey = JSON.stringify([baseUrl, runId]);
    const activeRequestId = runRequestsInFlightRef.current.get(requestKey);
    if (activeRequestId === runRequestSequenceRef.current) return;
    const requestId = ++runRequestSequenceRef.current;
    runRequestsInFlightRef.current.set(requestKey, requestId);
    try {
      const next = await getRemoteRun(baseUrl, runId);
      if (runRequestSequenceRef.current !== requestId) return;
      setRun(next);
      setRunError('');
    } catch (error) {
      if (runRequestSequenceRef.current !== requestId) return;
      const message = error instanceof Error ? error.message : 'Loop 상태를 불러오지 못했습니다.';
      if (message.includes('찾을 수 없습니다')) {
        const savedRunId = await AsyncStorage.getItem(RUN_KEY).catch(() => null);
        if (runRequestSequenceRef.current !== requestId) return;
        setRun(null);
        if (savedRunId === runId) await AsyncStorage.removeItem(RUN_KEY).catch(() => {});
      } else {
        setRunError(message);
      }
    } finally {
      if (runRequestsInFlightRef.current.get(requestKey) === requestId) {
        runRequestsInFlightRef.current.delete(requestKey);
      }
    }
  }, []);

  const refreshStatus = useCallback(async (value = serverUrl) => {
    const requestId = ++statusRequestRef.current;
    let baseUrl: string;
    try {
      baseUrl = normalizeTailscaleBaseUrl(value);
    } catch (error) {
      if (statusRequestRef.current !== requestId) return;
      setConnection('idle');
      setConnectionError(error instanceof Error ? error.message : 'Tailscale 주소를 확인해 주세요.');
      setSettingsOpen(true);
      return;
    }

    setRefreshing(true);
    setConnection('connecting');
    setConnectionError('');
    try {
      const result = await getRemoteStatus(baseUrl);
      if (statusRequestRef.current !== requestId) return;
      setStatus(result);
      if (result.tailscale.online && result.tailscale.serveEnabled && result.backendConnected) {
        setConnection('connected');
      } else {
        setConnection('offline');
        setConnectionError(!result.tailscale.online
          ? 'Mac의 Tailscale이 연결되어 있지 않습니다.'
          : !result.tailscale.serveEnabled
            ? 'Mac에서 Tailscale Serve 원격 접속을 켜 주세요.'
            : 'Mac의 Loopline 서버가 실행 중인지 확인해 주세요.');
      }
      const savedRunId = await AsyncStorage.getItem(RUN_KEY);
      if (statusRequestRef.current !== requestId) return;
      if (savedRunId) await refreshRun(baseUrl, savedRunId);
    } catch (error) {
      if (statusRequestRef.current !== requestId) return;
      setStatus(null);
      setConnection('offline');
      setConnectionError(error instanceof Error ? error.message : 'Mac에 연결하지 못했습니다.');
    } finally {
      if (statusRequestRef.current === requestId) setRefreshing(false);
    }
  }, [refreshRun, serverUrl]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      AsyncStorage.getItem(SETTINGS_KEY),
      AsyncStorage.getItem(CHAT_KEY),
    ]).then(([savedSettings, savedChat]) => {
      if (cancelled) return;
      if (savedSettings) {
        const parsed = JSON.parse(savedSettings) as {
          serverUrl?: string; chatModelKey?: string; roles?: RoleSelection; rounds?: number;
        };
        const savedUrl = typeof parsed.serverUrl === 'string' ? parsed.serverUrl : '';
        setServerUrl(savedUrl);
        setSettingsValue(savedUrl);
        setChatModelKey(typeof parsed.chatModelKey === 'string' ? parsed.chatModelKey : '');
        if (parsed.roles && typeof parsed.roles === 'object') {
          setRoles({planner: parsed.roles.planner || '', worker: parsed.roles.worker || '', judge: parsed.roles.judge || ''});
        }
        if (ROUND_OPTIONS.includes(parsed.rounds || -1)) setRounds(parsed.rounds || 0);
      }
      if (savedChat) {
        const parsed = JSON.parse(savedChat);
        if (Array.isArray(parsed)) {
          setChatItems(parsed.filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string').slice(-60));
        }
      }
    }).catch(() => {
      setConnectionError('이 기기의 설정을 읽지 못했습니다. 서버 주소를 다시 입력해 주세요.');
    }).finally(() => setHydrated(true));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    void AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({serverUrl, chatModelKey, roles, rounds})).catch(() => {});
  }, [chatModelKey, hydrated, roles, rounds, serverUrl]);

  useEffect(() => {
    if (!hydrated) return;
    void AsyncStorage.setItem(CHAT_KEY, JSON.stringify(chatItems.slice(-60))).catch(() => {});
  }, [chatItems, hydrated]);

  useEffect(() => {
    if (!hydrated || !serverUrl) return;
    void refreshStatus(serverUrl);
  }, [hydrated, refreshStatus, serverUrl]);

  useEffect(() => {
    if (!hydrated || !serverUrl || connection !== 'offline' || refreshing || settingsOpen || !appIsActive) return;
    const timer = setTimeout(() => void refreshStatus(serverUrl), 30_000);
    return () => clearTimeout(timer);
  }, [appIsActive, connection, hydrated, refreshing, refreshStatus, serverUrl, settingsOpen]);

  useEffect(() => {
    if (!hydrated || !normalizedUrl || !run || TERMINAL_REMOTE_RUN_STATES.has(run.status)) return;
    const timer = setTimeout(() => void refreshRun(normalizedUrl, run.id), 1_800);
    return () => clearTimeout(timer);
  }, [hydrated, normalizedUrl, refreshRun, run]);

  useEffect(() => {
    const listener = AppState.addEventListener('change', nextState => {
      setAppIsActive(nextState === 'active');
      if (nextState === 'active' && serverUrl) void refreshStatus(serverUrl);
    });
    return () => listener.remove();
  }, [refreshStatus, serverUrl]);

  const cancelChatStream = (emptyResponseMessage: string) => {
    const activeStream = streamRef.current;
    if (!activeStream) return;
    chatRequestSequenceRef.current += 1;
    streamRef.current = null;
    activeStream.abort();
    setChatItems(current => current.map(item => item.id === activeStream.assistantItemId && !item.content
      ? {...item, content: emptyResponseMessage}
      : item));
    setChatBusy(false);
  };

  const saveServer = async () => {
    try {
      const baseUrl = normalizeTailscaleBaseUrl(settingsValue);
      setSettingsError('');
      if (streamRef.current && streamRef.current.baseUrl !== baseUrl) {
        cancelChatStream('서버 주소가 변경되어 응답을 중지했습니다.');
      }
      setServerUrl(baseUrl);
      setSettingsValue(baseUrl);
      setSettingsOpen(false);
      await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify({serverUrl: baseUrl, chatModelKey, roles, rounds}));
      await refreshStatus(baseUrl);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : '주소를 확인해 주세요.');
    }
  };

  const applyModelDefaults = (choices: ModelChoice[]) => {
    if (!choices.length) return;
    const chatChoices = choices.filter(model => !model.decisionOnly);
    setChatModelKey(current => chatChoices.some(model => model.key === current) ? current : chatChoices[0]?.key || '');
    setRoles(current => {
      const workers = choices.filter(model => !model.decisionOnly);
      const judges = choices;
      return {
        planner: workers.some(model => model.key === current.planner) ? current.planner : workers[0]?.key || '',
        worker: workers.some(model => model.key === current.worker) ? current.worker : workers[0]?.key || '',
        judge: judges.some(model => model.key === current.judge) ? current.judge : judges.find(model => model.decisionOnly)?.key || judges[0]?.key || '',
      };
    });
  };

  useEffect(() => { applyModelDefaults(models); }, [models]);

  const chooseModel = (key: string) => {
    if (!rolePicker) return;
    if (rolePicker === 'chat') setChatModelKey(key);
    else setRoles(current => ({...current, [rolePicker]: key}));
    setRolePicker(null);
  };

  const sendChat = async () => {
    const content = chatInput.trim();
    if (!content || !currentChatModel || !normalizedUrl || chatBusy) return;
    const requestId = ++chatRequestSequenceRef.current;
    const userItem: ChatItem = {id: makeId(), role: 'user', content};
    const assistantItem: ChatItem = {id: makeId(), role: 'assistant', content: ''};
    const context = [...chatItems, userItem].slice(-24).map(item => ({role: item.role, content: item.content}));
    setChatInput('');
    setChatItems(current => [...current, userItem, assistantItem].slice(-60));
    setChatBusy(true);
    const stream = startRemoteChatStream(normalizedUrl, {modelKey: currentChatModel.key, messages: context}, event => {
      if (chatRequestSequenceRef.current === requestId && event.name === 'delta' && typeof event.data.text === 'string') {
        setChatItems(current => current.map(item => item.id === assistantItem.id ? {...item, content: item.content + String(event.data.text)} : item));
      }
    });
    streamRef.current = {requestId, assistantItemId: assistantItem.id, baseUrl: normalizedUrl, abort: stream.abort};
    try {
      await stream.promise;
    } catch (error) {
      if (chatRequestSequenceRef.current !== requestId) return;
      if (error instanceof Error && error.name === 'AbortError') {
        setChatItems(current => current.map(item => item.id === assistantItem.id
          ? {...item, content: item.content || '응답을 중지했습니다.'} : item));
      } else {
        setChatItems(current => current.map(item => item.id === assistantItem.id
          ? {...item, content: `${item.content ? `${item.content}\n\n` : ''}오류: ${error instanceof Error ? error.message : '응답에 실패했습니다.'}`, error: true}
          : item));
      }
    } finally {
      if (chatRequestSequenceRef.current === requestId) {
        if (streamRef.current?.requestId === requestId) streamRef.current = null;
        setChatBusy(false);
      }
    }
  };

  const startLoop = async () => {
    if (!normalizedUrl || !canStartLoop) return;
    invalidateRunRefresh();
    setRunBusy(true);
    setRunError('');
    try {
      const next = await createRemoteRun(normalizedUrl, {task: taskInput.trim(), roles, rounds});
      invalidateRunRefresh();
      setRun(next);
      setTaskInput('');
      await AsyncStorage.setItem(RUN_KEY, next.id);
    } catch (error) {
      if (error instanceof RemoteApiError && error.body.run && typeof error.body.run === 'object') {
        invalidateRunRefresh();
        const activeRun = error.body.run as RemoteRun;
        setRun(activeRun);
        await AsyncStorage.setItem(RUN_KEY, activeRun.id);
        setRunError('이미 진행 중인 원격 Loop 작업을 열었습니다.');
      } else {
        setRunError(error instanceof Error ? error.message : 'Loop를 시작하지 못했습니다.');
      }
    } finally {
      setRunBusy(false);
    }
  };

  const stopLoop = async () => {
    if (!normalizedUrl || !run || runBusy) return;
    invalidateRunRefresh();
    setRunBusy(true);
    setRunError('');
    try {
      const stoppedRun = await stopRemoteRun(normalizedUrl, run.id);
      invalidateRunRefresh();
      setRun(stoppedRun);
    } catch (error) { setRunError(error instanceof Error ? error.message : '중지 요청을 보내지 못했습니다.'); }
    finally { setRunBusy(false); }
  };

  const resumeLoop = async () => {
    if (!normalizedUrl || !run || runBusy) return;
    invalidateRunRefresh();
    setRunBusy(true);
    setRunError('');
    try {
      const resumedRun = await resumeRemoteRun(normalizedUrl, run.id);
      invalidateRunRefresh();
      setRun(resumedRun);
    } catch (error) { setRunError(error instanceof Error ? error.message : 'Loop를 이어가지 못했습니다.'); }
    finally { setRunBusy(false); }
  };

  const clearRun = async () => {
    invalidateRunRefresh();
    setRun(null);
    setRunError('');
    await AsyncStorage.removeItem(RUN_KEY).catch(() => {});
  };

  const visibleModels = rolePicker === 'judge' ? models : workingModels;
  const rolePickerValue = rolePicker === 'chat' ? chatModelKey : rolePicker ? roles[rolePicker] : '';
  const connectionText = connection === 'connecting' || refreshing ? '연결 확인 중'
    : connection === 'connected' ? 'Mac 연결됨'
      : connection === 'offline' ? '연결 확인 필요' : 'Tailscale 연결 설정';

  if (!hydrated) {
    return <SafeAreaView style={styles.loading}><StatusBar barStyle="light-content" backgroundColor={COLORS.background} /><ActivityIndicator color={COLORS.accent} /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor={COLORS.background} />
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <View style={styles.brandRow}>
            <View style={styles.brandIcon}><Text style={styles.brandGlyph}>∞</Text></View>
            <View><Text style={styles.brand}>Loopline</Text><Text style={styles.brandSub}>PHONE CONTROL</Text></View>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="서버 연결 설정" onPress={() => { setSettingsValue(serverUrl); setSettingsError(''); setSettingsOpen(true); }} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>⚙</Text>
          </Pressable>
        </View>

        <Pressable accessibilityRole="button" onPress={() => normalizedUrl ? void refreshStatus(normalizedUrl) : setSettingsOpen(true)} style={styles.connectionCard}>
          <View style={[styles.connectionDot, connection === 'connected' && styles.connectionDotOnline, connection === 'offline' && styles.connectionDotOffline]} />
          <View style={styles.connectionCopy}>
            <Text style={styles.connectionTitle}>{connectionText}</Text>
            <Text numberOfLines={1} style={styles.connectionDescription}>{serverUrl || 'Mac의 Tailscale Serve 주소를 설정해 주세요'}</Text>
          </View>
          {refreshing ? <ActivityIndicator size="small" color={COLORS.muted} /> : <Text style={styles.connectionRefresh}>↻</Text>}
        </Pressable>

        {connectionError ? (
          <View style={styles.notice}><Text style={styles.noticeText}>{connectionError}{connection === 'offline' ? '\n앱이 열려 있는 동안 30초마다 자동으로 다시 확인합니다.' : ''}</Text><Pressable onPress={() => setSettingsOpen(true)}><Text style={styles.noticeAction}>설정</Text></Pressable></View>
        ) : null}

        <View style={styles.tabs}>
          <Pressable accessibilityRole="tab" accessibilityState={{selected: tab === 'loop'}} onPress={() => setTab('loop')} style={[styles.tab, tab === 'loop' && styles.tabSelected]}>
            <Text style={[styles.tabText, tab === 'loop' && styles.tabTextSelected]}>Loop Engineering</Text>
          </Pressable>
          <Pressable accessibilityRole="tab" accessibilityState={{selected: tab === 'chat'}} onPress={() => setTab('chat')} style={[styles.tab, tab === 'chat' && styles.tabSelected]}>
            <Text style={[styles.tabText, tab === 'chat' && styles.tabTextSelected]}>대화</Text>
          </Pressable>
        </View>

        {tab === 'loop' ? (
          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
            {!run || TERMINAL_REMOTE_RUN_STATES.has(run.status) ? (
              <View style={styles.panel}>
                <View style={styles.panelHeading}>
                  <View><Text style={styles.eyebrow}>AUTONOMOUS WORKFLOW</Text><Text style={styles.panelTitle}>새 Loop 작업</Text></View>
                  <Text style={styles.roundBadge}>{rounds === 0 ? '자동 회차' : `최대 ${rounds}회`}</Text>
                </View>
                <Text style={styles.fieldLabel}>작업 목표</Text>
                <TextInput
                  accessibilityLabel="작업 목표"
                  value={taskInput}
                  onChangeText={setTaskInput}
                  placeholder="만들거나 수정할 내용을 적어 주세요"
                  placeholderTextColor={COLORS.dim}
                  multiline
                  textAlignVertical="top"
                  style={[styles.textInput, styles.taskInput]}
                />

                <Text style={styles.sectionTitle}>역할별 모델</Text>
                {(['planner', 'worker', 'judge'] as const).map(role => {
                  const selected = roleModel(role);
                  return (
                    <Pressable key={role} accessibilityRole="button" accessibilityLabel={`${roleName(role)} 모델 선택`} onPress={() => setRolePicker(role)} style={styles.roleRow}>
                      <View style={styles.roleIcon}><Text style={styles.roleIconText}>{role === 'planner' ? '01' : role === 'worker' ? '02' : '03'}</Text></View>
                      <View style={styles.roleTextWrap}><Text style={styles.roleLabel}>{roleName(role)}</Text><Text numberOfLines={1} style={styles.roleModel}>{modelName(selected)}</Text></View>
                      <Text style={styles.roleChevron}>›</Text>
                    </Pressable>
                  );
                })}

                <Text style={styles.fieldLabel}>회차 한도</Text>
                <View style={styles.roundOptions}>
                  {ROUND_OPTIONS.map(value => (
                    <Pressable key={value} accessibilityRole="radio" accessibilityState={{selected: rounds === value}} onPress={() => setRounds(value)} style={[styles.roundOption, rounds === value && styles.roundOptionSelected]}>
                      <Text style={[styles.roundOptionText, rounds === value && styles.roundOptionTextSelected]}>{value === 0 ? '자동' : value}</Text>
                    </Pressable>
                  ))}
                </View>
                <Text style={styles.helperText}>선택한 계획·구현·판정 모델로 Mac의 격리 작업에서 실행합니다. 승인 없이 자동 검증·반영하며, 중지는 언제든 요청할 수 있습니다.</Text>

                {runError ? <Text accessibilityRole="alert" style={styles.errorText}>{runError}</Text> : null}
                <Pressable accessibilityRole="button" disabled={!canStartLoop} onPress={() => void startLoop()} style={[styles.primaryButton, !canStartLoop && styles.buttonDisabled]}>
                  {runBusy ? <ActivityIndicator color="#121518" /> : <Text style={styles.primaryButtonText}>Loop 시작  →</Text>}
                </Pressable>
              </View>
            ) : null}

            {run ? <RunCard run={run} busy={runBusy} error={runError} onStop={() => void stopLoop()} onResume={() => void resumeLoop()} onClear={() => void clearRun()} expandedEventId={expandedEventId} onToggleEvent={setExpandedEventId} /> : null}

            {connection !== 'connected' ? (
              <View style={styles.emptyPanel}>
                <Text style={styles.emptyGlyph}>⌁</Text>
                <Text style={styles.emptyTitle}>Mac에 연결하면 작업을 시작할 수 있어요</Text>
                <Text style={styles.emptyDescription}>Mac에서 Loopline과 Tailscale Serve를 켜고, 이 iPhone도 같은 Tailnet에 연결해 주세요.</Text>
                <Pressable onPress={() => setSettingsOpen(true)} style={styles.secondaryAction}><Text style={styles.secondaryActionText}>연결 설정</Text></Pressable>
              </View>
            ) : null}
          </ScrollView>
        ) : (
          <View style={styles.chatScreen}>
            <View style={styles.chatModelRow}>
              <View><Text style={styles.fieldLabel}>응답 모델</Text><Text numberOfLines={1} style={styles.chatModelName}>{modelName(currentChatModel)}</Text></View>
              <Pressable onPress={() => setRolePicker('chat')} style={styles.smallOutlineButton}><Text style={styles.smallOutlineText}>변경</Text></Pressable>
            </View>
            <ScrollView ref={chatScrollRef} style={styles.chatMessages} contentContainerStyle={styles.chatMessageContent} keyboardShouldPersistTaps="handled" onContentSizeChange={() => chatScrollRef.current?.scrollToEnd({animated: true})}>
              {!chatItems.length ? <View style={styles.chatEmpty}><Text style={styles.chatEmptyGlyph}>✳</Text><Text style={styles.chatEmptyTitle}>무엇을 도와드릴까요?</Text><Text style={styles.chatEmptyDescription}>선택한 모델로 Mac을 통해 안전하게 대화합니다.</Text></View> : null}
              {chatItems.map(item => <View key={item.id} style={[styles.chatBubble, item.role === 'user' ? styles.userBubble : styles.assistantBubble, item.error && styles.errorBubble]}><Text style={styles.chatBubbleText}>{item.content || (chatBusy && item.role === 'assistant' ? '응답을 기다리는 중…' : '')}</Text></View>)}
            </ScrollView>
            <View style={styles.composer}>
              <TextInput
                accessibilityLabel="메시지 입력"
                value={chatInput}
                onChangeText={setChatInput}
                placeholder="메시지를 입력하세요"
                placeholderTextColor={COLORS.dim}
                multiline
                maxLength={20_000}
                style={styles.composerInput}
              />
              <Pressable accessibilityRole="button" accessibilityLabel={chatBusy ? '응답 중지' : '메시지 전송'} disabled={!chatBusy && (!chatInput.trim() || !currentChatModel || connection !== 'connected')} onPress={() => chatBusy ? cancelChatStream('응답을 중지했습니다.') : void sendChat()} style={[styles.sendButton, !chatBusy && (!chatInput.trim() || !currentChatModel || connection !== 'connected') && styles.buttonDisabled]}>
                <Text style={styles.sendButtonText}>{chatBusy ? '■' : '↑'}</Text>
              </Pressable>
            </View>
          </View>
        )}

        <Modal transparent animationType="slide" visible={settingsOpen} onRequestClose={() => setSettingsOpen(false)}>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard}>
              <View style={styles.modalHeading}><View><Text style={styles.eyebrow}>SECURE CONNECTION</Text><Text style={styles.modalTitle}>Mac 연결 설정</Text></View><Pressable accessibilityLabel="닫기" onPress={() => setSettingsOpen(false)}><Text style={styles.closeButton}>×</Text></Pressable></View>
              <Text style={styles.fieldLabel}>Tailscale Serve 주소</Text>
              <TextInput
                accessibilityLabel="Mac Tailscale Serve 주소"
                value={settingsValue}
                onChangeText={setSettingsValue}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://mac.tailnet.ts.net/loopline"
                placeholderTextColor={COLORS.dim}
                style={styles.textInput}
              />
              <Text style={styles.helperText}>iPhone에 Tailscale 앱을 설치하고 Mac과 같은 Tailnet에 연결해야 합니다. 주소는 Mac Loopline의 원격 접속 화면에서 확인할 수 있습니다.</Text>
              {settingsError ? <Text accessibilityRole="alert" style={styles.errorText}>{settingsError}</Text> : null}
              <View style={styles.modalActions}>
                <Pressable onPress={() => setSettingsOpen(false)} style={styles.cancelButton}><Text style={styles.cancelButtonText}>취소</Text></Pressable>
                <Pressable onPress={() => void saveServer()} style={styles.primaryButtonCompact}><Text style={styles.primaryButtonText}>연결</Text></Pressable>
              </View>
            </View>
          </View>
        </Modal>

        <Modal transparent animationType="slide" visible={rolePicker !== null} onRequestClose={() => setRolePicker(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.modalCard, styles.modelModalCard]}>
              <View style={styles.modalHeading}><View><Text style={styles.eyebrow}>MODEL SELECTION</Text><Text style={styles.modalTitle}>{rolePicker ? roleName(rolePicker) : '모델 선택'}</Text></View><Pressable accessibilityLabel="닫기" onPress={() => setRolePicker(null)}><Text style={styles.closeButton}>×</Text></Pressable></View>
              <ScrollView style={styles.modelList} keyboardShouldPersistTaps="handled">
                {visibleModels.map(model => (
                  <Pressable key={model.key} onPress={() => chooseModel(model.key)} style={[styles.modelChoice, rolePickerValue === model.key && styles.modelChoiceSelected]}>
                    <View style={styles.modelChoiceGlyph}><Text style={styles.modelChoiceGlyphText}>{model.providerLabel.slice(0, 1)}</Text></View>
                    <View style={styles.modelChoiceCopy}><Text style={styles.modelChoiceName}>{model.label}</Text><Text style={styles.modelChoiceMeta}>{model.providerLabel}{model.accountName || model.connectionName ? ` · ${model.accountName || model.connectionName}` : ''}{model.decisionOnly ? ' · 판정 전용' : ''}</Text></View>
                    {rolePickerValue === model.key ? <Text style={styles.modelCheck}>✓</Text> : null}
                  </Pressable>
                ))}
                {!visibleModels.length ? <Text style={styles.noModels}>사용 가능한 모델이 없습니다. Mac에서 모델 계정을 연결해 주세요.</Text> : null}
              </ScrollView>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function RunCard({run, busy, error, onStop, onResume, onClear, expandedEventId, onToggleEvent}: {
  run: RemoteRun; busy: boolean; error: string; onStop: () => void; onResume: () => void; onClear: () => void;
  expandedEventId: string; onToggleEvent: (id: string) => void;
}) {
  const terminal = TERMINAL_REMOTE_RUN_STATES.has(run.status);
  const statusColor = ['completed', 'reviewed'].includes(run.status) ? COLORS.green
    : ['failed', 'blocked', 'interrupted', 'limit'].includes(run.status) ? COLORS.red : COLORS.accent;
  return (
    <View style={styles.runPanel}>
      <View style={styles.runHeader}>
        <View style={styles.runHeaderCopy}><Text style={styles.eyebrow}>LIVE LOOP</Text><Text numberOfLines={1} style={styles.runTitle}>{stageLabel(run.stage)}{run.round ? ` · ${run.round}/${run.rounds || '자동'}회차` : ''}</Text></View>
        <View style={[styles.runStatusPill, {borderColor: `${statusColor}55`}]}><View style={[styles.runStatusDot, {backgroundColor: statusColor}]} /><Text style={[styles.runStatusText, {color: statusColor}]}>{statusLabel(run.status)}</Text></View>
      </View>
      <Text style={styles.runTask}>{run.task}</Text>
      {run.summary ? <Text style={styles.runSummary}>{run.summary}</Text> : <Text style={styles.runSummary}>계획부터 구현·검증까지 진행 중입니다.</Text>}
      <View style={styles.stepHeading}><Text style={styles.sectionTitle}>작업 단계</Text><Text style={styles.eventCount}>{run.events.length}개 기록</Text></View>
      {!run.events.length ? <Text style={styles.helperText}>첫 단계가 시작되면 사용 모델과 진행 결과가 표시됩니다.</Text> : null}
      {run.events.map((event, index) => {
        const id = event.id || `${index}-${event.title}`;
        const expanded = expandedEventId === id;
        const eventModel = event.model?.label || event.model?.model;
        return (
          <Pressable key={id} onPress={() => onToggleEvent(expanded ? '' : id)} style={styles.eventRow}>
            <View style={[styles.eventMarker, ['failed', 'error'].includes(event.status || '') && styles.eventMarkerFailed, ['completed', 'done'].includes(event.status || '') && styles.eventMarkerDone]} />
            <View style={styles.eventContent}>
              <View style={styles.eventTitleRow}><Text style={styles.eventTitle}>{event.title || 'Loop 단계'}</Text><Text style={styles.eventChevron}>{expanded ? '−' : '+'}</Text></View>
              {eventModel ? <Text style={styles.eventModel}>{[event.model?.provider, eventModel].filter(Boolean).join(' · ')}</Text> : null}
              {expanded && event.detail ? <Text style={styles.eventDetail}>{event.detail}</Text> : null}
            </View>
          </Pressable>
        );
      })}
      {error ? <Text accessibilityRole="alert" style={styles.errorText}>{error}</Text> : null}
      <View style={styles.runActions}>
        {!terminal ? <Pressable disabled={busy} onPress={onStop} style={styles.stopAction}>{busy ? <ActivityIndicator color={COLORS.red} size="small" /> : <Text style={styles.stopActionText}>작업 중지</Text>}</Pressable> : null}
        {run.canResume ? <Pressable disabled={busy} onPress={onResume} style={styles.resumeAction}>{busy ? <ActivityIndicator color={COLORS.text} size="small" /> : <Text style={styles.resumeActionText}>이어하기</Text>}</Pressable> : null}
        {terminal ? <Pressable onPress={onClear} style={styles.clearAction}><Text style={styles.clearActionText}>기록 닫기</Text></Pressable> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: COLORS.background},
  loading: {flex: 1, backgroundColor: COLORS.background, alignItems: 'center', justifyContent: 'center'},
  root: {flex: 1, backgroundColor: COLORS.background},
  header: {height: 64, paddingHorizontal: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  brandRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  brandIcon: {width: 36, height: 36, borderRadius: 12, backgroundColor: '#26364a', borderWidth: 1, borderColor: '#37516f', alignItems: 'center', justifyContent: 'center'},
  brandGlyph: {fontSize: 26, lineHeight: 30, color: '#c8deff'},
  brand: {fontSize: 16, lineHeight: 20, fontWeight: '700', color: COLORS.text, letterSpacing: 0.3},
  brandSub: {fontSize: 8, color: COLORS.dim, letterSpacing: 1.3, marginTop: 2},
  headerButton: {width: 38, height: 38, borderRadius: 13, borderWidth: 1, borderColor: COLORS.border, alignItems: 'center', justifyContent: 'center'},
  headerButtonText: {fontSize: 18, color: COLORS.muted},
  connectionCard: {marginHorizontal: 16, minHeight: 59, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, borderRadius: 16},
  connectionDot: {width: 8, height: 8, borderRadius: 6, backgroundColor: COLORS.amber},
  connectionDotOnline: {backgroundColor: COLORS.green},
  connectionDotOffline: {backgroundColor: COLORS.red},
  connectionCopy: {flex: 1},
  connectionTitle: {fontSize: 12, color: COLORS.text, fontWeight: '600'},
  connectionDescription: {fontSize: 10, color: COLORS.dim, marginTop: 3},
  connectionRefresh: {fontSize: 20, lineHeight: 22, color: COLORS.muted, paddingHorizontal: 3},
  notice: {marginHorizontal: 16, marginTop: 9, minHeight: 39, borderRadius: 11, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', backgroundColor: '#30231b', borderWidth: 1, borderColor: '#57412b', gap: 8},
  noticeText: {flex: 1, fontSize: 10, color: '#dfc39c', lineHeight: 15},
  noticeAction: {fontSize: 10, color: COLORS.accent, fontWeight: '700', padding: 5},
  tabs: {marginTop: 14, marginHorizontal: 16, padding: 4, flexDirection: 'row', borderRadius: 13, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border},
  tab: {flex: 1, minHeight: 36, borderRadius: 9, alignItems: 'center', justifyContent: 'center'},
  tabSelected: {backgroundColor: '#303841'},
  tabText: {fontSize: 11, color: COLORS.dim, fontWeight: '600'},
  tabTextSelected: {color: COLORS.text},
  scroll: {flex: 1},
  scrollContent: {padding: 16, paddingBottom: 30, gap: 13},
  panel: {backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, borderRadius: 19, padding: 16},
  panelHeading: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18},
  eyebrow: {fontSize: 8, color: COLORS.dim, fontWeight: '700', letterSpacing: 1.35, marginBottom: 5},
  panelTitle: {fontSize: 19, color: COLORS.text, fontWeight: '700'},
  roundBadge: {fontSize: 9, color: COLORS.accent, fontWeight: '600', borderWidth: 1, borderColor: '#3a5270', backgroundColor: '#202e3e', overflow: 'hidden', borderRadius: 9, paddingHorizontal: 8, paddingVertical: 5},
  fieldLabel: {fontSize: 10, fontWeight: '600', color: '#c9cdd1', marginBottom: 7},
  textInput: {minHeight: 43, color: COLORS.text, fontSize: 12, borderRadius: 11, borderWidth: 1, borderColor: '#3b4147', backgroundColor: '#14171a', paddingHorizontal: 11, paddingVertical: 10},
  taskInput: {minHeight: 103, lineHeight: 18, marginBottom: 17},
  sectionTitle: {fontSize: 12, fontWeight: '700', color: '#e1e5e8'},
  roleRow: {minHeight: 59, marginTop: 7, borderRadius: 12, paddingHorizontal: 9, flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.surfaceRaised, gap: 9},
  roleIcon: {width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: '#2e3c4b'},
  roleIconText: {fontSize: 9, color: '#bad5f8', fontWeight: '700'},
  roleTextWrap: {flex: 1},
  roleLabel: {fontSize: 9, color: COLORS.dim},
  roleModel: {fontSize: 11, color: COLORS.text, marginTop: 3, fontWeight: '600'},
  roleChevron: {fontSize: 21, color: COLORS.dim, paddingHorizontal: 4},
  roundOptions: {flexDirection: 'row', gap: 7, marginTop: 3},
  roundOption: {height: 35, minWidth: 42, paddingHorizontal: 12, borderRadius: 10, backgroundColor: COLORS.surfaceRaised, borderWidth: 1, borderColor: COLORS.border, alignItems: 'center', justifyContent: 'center'},
  roundOptionSelected: {backgroundColor: '#27384b', borderColor: '#57799f'},
  roundOptionText: {fontSize: 10, color: COLORS.muted, fontWeight: '600'},
  roundOptionTextSelected: {color: '#d5e7ff'},
  helperText: {fontSize: 9, color: COLORS.dim, lineHeight: 15, marginTop: 11},
  primaryButton: {height: 47, marginTop: 15, borderRadius: 13, backgroundColor: '#d9e7f7', alignItems: 'center', justifyContent: 'center'},
  primaryButtonText: {fontSize: 12, color: '#17202a', fontWeight: '700'},
  buttonDisabled: {opacity: 0.38},
  emptyPanel: {paddingVertical: 19, paddingHorizontal: 16, borderRadius: 16, alignItems: 'center', backgroundColor: '#15181b', borderWidth: 1, borderStyle: 'dashed', borderColor: '#353b40'},
  emptyGlyph: {fontSize: 24, color: COLORS.dim},
  emptyTitle: {marginTop: 8, fontSize: 12, color: COLORS.text, fontWeight: '600', textAlign: 'center'},
  emptyDescription: {marginTop: 6, color: COLORS.dim, fontSize: 9, lineHeight: 15, textAlign: 'center'},
  secondaryAction: {marginTop: 12, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 10, borderWidth: 1, borderColor: COLORS.border},
  secondaryActionText: {fontSize: 10, color: COLORS.accent, fontWeight: '600'},
  errorText: {marginTop: 9, color: COLORS.red, fontSize: 10, lineHeight: 15},
  runPanel: {padding: 15, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, borderRadius: 18},
  runHeader: {flexDirection: 'row', alignItems: 'center', gap: 8},
  runHeaderCopy: {flex: 1},
  runTitle: {fontSize: 13, fontWeight: '700', color: COLORS.text},
  runStatusPill: {minHeight: 25, paddingHorizontal: 8, borderRadius: 10, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 5},
  runStatusDot: {width: 6, height: 6, borderRadius: 4},
  runStatusText: {fontSize: 9, fontWeight: '600'},
  runTask: {fontSize: 11, lineHeight: 17, color: '#d4d9de', marginTop: 12},
  runSummary: {fontSize: 10, lineHeight: 16, color: COLORS.muted, marginTop: 6},
  stepHeading: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, marginBottom: 4},
  eventCount: {fontSize: 9, color: COLORS.dim},
  eventRow: {flexDirection: 'row', gap: 10, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#30363b'},
  eventMarker: {width: 8, height: 8, borderRadius: 5, marginTop: 4, backgroundColor: '#718ba6'},
  eventMarkerDone: {backgroundColor: COLORS.green},
  eventMarkerFailed: {backgroundColor: COLORS.red},
  eventContent: {flex: 1},
  eventTitleRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  eventTitle: {flex: 1, fontSize: 10, color: '#e0e4e8', fontWeight: '600'},
  eventChevron: {fontSize: 14, color: COLORS.dim, paddingHorizontal: 4},
  eventModel: {fontSize: 9, color: COLORS.accent, marginTop: 4},
  eventDetail: {fontSize: 10, color: COLORS.muted, lineHeight: 15, marginTop: 8},
  runActions: {minHeight: 41, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'flex-end', gap: 8, marginTop: 9},
  stopAction: {height: 33, paddingHorizontal: 11, borderRadius: 10, backgroundColor: '#372426', alignItems: 'center', justifyContent: 'center'},
  stopActionText: {fontSize: 10, color: COLORS.red, fontWeight: '600'},
  resumeAction: {height: 33, paddingHorizontal: 13, borderRadius: 10, backgroundColor: '#30363d', alignItems: 'center', justifyContent: 'center'},
  resumeActionText: {fontSize: 10, color: COLORS.text, fontWeight: '600'},
  clearAction: {height: 33, paddingHorizontal: 11, alignItems: 'center', justifyContent: 'center'},
  clearActionText: {fontSize: 10, color: COLORS.dim},
  chatScreen: {flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 9},
  chatModelRow: {minHeight: 55, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1, borderBottomColor: COLORS.border},
  chatModelName: {maxWidth: 250, fontSize: 11, color: COLORS.text, fontWeight: '600'},
  smallOutlineButton: {borderWidth: 1, borderColor: COLORS.border, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 6},
  smallOutlineText: {fontSize: 9, color: COLORS.accent, fontWeight: '600'},
  chatMessages: {flex: 1},
  chatMessageContent: {paddingTop: 14, paddingBottom: 18, gap: 10},
  chatEmpty: {flex: 1, minHeight: 280, alignItems: 'center', justifyContent: 'center'},
  chatEmptyGlyph: {fontSize: 26, color: COLORS.accent},
  chatEmptyTitle: {fontSize: 15, color: COLORS.text, fontWeight: '700', marginTop: 12},
  chatEmptyDescription: {fontSize: 10, color: COLORS.dim, marginTop: 7},
  chatBubble: {maxWidth: '91%', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 15},
  userBubble: {alignSelf: 'flex-end', backgroundColor: '#2d3c4c', borderBottomRightRadius: 5},
  assistantBubble: {alignSelf: 'flex-start', backgroundColor: COLORS.surfaceRaised, borderBottomLeftRadius: 5},
  errorBubble: {borderWidth: 1, borderColor: '#633a3f'},
  chatBubbleText: {fontSize: 11, color: COLORS.text, lineHeight: 17},
  composer: {minHeight: 58, padding: 7, flexDirection: 'row', alignItems: 'flex-end', gap: 7, backgroundColor: COLORS.surfaceRaised, borderWidth: 1, borderColor: COLORS.border, borderRadius: 17},
  composerInput: {flex: 1, maxHeight: 110, minHeight: 38, fontSize: 11, lineHeight: 16, color: COLORS.text, paddingHorizontal: 8, paddingTop: 9, paddingBottom: 8},
  sendButton: {width: 38, height: 38, borderRadius: 13, backgroundColor: '#d9e7f7', alignItems: 'center', justifyContent: 'center'},
  sendButtonText: {fontSize: 18, color: '#121820', fontWeight: '700'},
  modalBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.64)'},
  modalCard: {padding: 18, paddingBottom: 28, borderTopLeftRadius: 23, borderTopRightRadius: 23, borderWidth: 1, borderColor: COLORS.border, backgroundColor: '#1c2024'},
  modelModalCard: {height: '74%'},
  modalHeading: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18},
  modalTitle: {fontSize: 19, color: COLORS.text, fontWeight: '700'},
  closeButton: {fontSize: 27, lineHeight: 29, color: COLORS.muted, paddingHorizontal: 6},
  modalActions: {flexDirection: 'row', justifyContent: 'flex-end', gap: 9, marginTop: 17},
  cancelButton: {height: 42, paddingHorizontal: 14, borderWidth: 1, borderColor: COLORS.border, borderRadius: 12, alignItems: 'center', justifyContent: 'center'},
  cancelButtonText: {fontSize: 10, color: COLORS.muted, fontWeight: '600'},
  primaryButtonCompact: {height: 42, minWidth: 91, paddingHorizontal: 14, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#d9e7f7'},
  modelList: {flex: 1},
  modelChoice: {minHeight: 59, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderColor: 'transparent', borderRadius: 12, backgroundColor: COLORS.surfaceRaised, marginBottom: 7},
  modelChoiceSelected: {borderColor: '#5d7da2', backgroundColor: '#283747'},
  modelChoiceGlyph: {width: 31, height: 31, borderRadius: 10, backgroundColor: '#34475c', alignItems: 'center', justifyContent: 'center'},
  modelChoiceGlyphText: {fontSize: 11, color: '#d3e4fb', fontWeight: '700'},
  modelChoiceCopy: {flex: 1},
  modelChoiceName: {fontSize: 11, color: COLORS.text, fontWeight: '600'},
  modelChoiceMeta: {fontSize: 9, color: COLORS.dim, marginTop: 4},
  modelCheck: {fontSize: 16, color: COLORS.accent, paddingHorizontal: 5},
  noModels: {fontSize: 10, color: COLORS.muted, textAlign: 'center', lineHeight: 16, paddingVertical: 26},
});
