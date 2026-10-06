import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  DEFAULT_API_BASE_URL,
  LOOP_COMPLETE_MARKER,
  loadModelChoices,
  normalizeLocalApiUrl,
  startChatStream,
} from './src/api';
import type {
  ChatMessage,
  Conversation,
  LoopRound,
  ModelChoice,
  StoredPreferences,
} from './src/types';

const CONVERSATIONS_KEY = 'loopline.native.conversations.v1';
const PREFERENCES_KEY = 'loopline.native.preferences.v1';
const MAX_SAVED_CONVERSATIONS = 80;
const MAX_CONTEXT_MESSAGES = 60;
const ROUND_OPTIONS = [2, 3, 4, 5, 6];

type ModalName = 'models' | 'settings' | null;
type ConnectionState = 'checking' | 'connected' | 'offline';

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeConversation(): Conversation {
  return {
    id: makeId(),
    title: '새 대화',
    updatedAt: Date.now(),
    messages: [],
  };
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('ko-KR', {hour: '2-digit', minute: '2-digit'}).format(value);
}

function providerInitial(model: ModelChoice): string {
  if (model.provider === 'openai') return 'C';
  if (model.provider === 'anthropic') return 'A';
  return '·';
}

function roundLabel(round: LoopRound): string {
  if (round.status === 'running') return '진행 중';
  if (round.status === 'completed') return '완료';
  if (round.status === 'stopped') return '중지';
  return '실패';
}

function shorten(value: string, max = 58): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

export default function App() {
  const [hydrated, setHydrated] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE_URL);
  const [settingsUrl, setSettingsUrl] = useState(DEFAULT_API_BASE_URL);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('checking');
  const [connectionCount, setConnectionCount] = useState(0);
  const [connectionMessage, setConnectionMessage] = useState('서버 상태 확인 중');
  const [modal, setModal] = useState<ModalName>(null);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [maxRounds, setMaxRounds] = useState(3);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeRound, setActiveRound] = useState(0);
  const [expandedRound, setExpandedRound] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const activeStreamRef = useRef<{abort: () => void} | null>(null);
  const stopRequestedRef = useRef(false);
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeConversation = useMemo(
    () => conversations.find(conversation => conversation.id === activeConversationId) || null,
    [activeConversationId, conversations],
  );
  const selectedModel = useMemo(
    () => models.find(model => model.key === selectedModelKey) || null,
    [models, selectedModelKey],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      AsyncStorage.getItem(CONVERSATIONS_KEY),
      AsyncStorage.getItem(PREFERENCES_KEY),
    ]).then(([savedConversations, savedPreferences]) => {
      if (cancelled) return;
      const parsedConversations = savedConversations ? JSON.parse(savedConversations) : [];
      const parsedPreferences = savedPreferences ? JSON.parse(savedPreferences) : {};
      const conversationList = Array.isArray(parsedConversations)
        ? parsedConversations.filter((item: unknown): item is Conversation => Boolean(item && typeof item === 'object' && 'id' in item && 'messages' in item))
            .slice(0, MAX_SAVED_CONVERSATIONS)
        : [];
      const preferences = parsedPreferences as StoredPreferences;
      const initialConversations = conversationList.length ? conversationList : [makeConversation()];
      setConversations(initialConversations);
      setActiveConversationId(initialConversations[0].id);
      const initialUrl = typeof preferences.apiBaseUrl === 'string'
        ? preferences.apiBaseUrl
        : DEFAULT_API_BASE_URL;
      setApiBaseUrl(initialUrl);
      setSettingsUrl(initialUrl);
      setSelectedModelKey(typeof preferences.selectedModelKey === 'string' ? preferences.selectedModelKey : '');
      setLoopEnabled(preferences.loopEnabled === true);
      setMaxRounds(ROUND_OPTIONS.includes(preferences.maxRounds || 0) ? preferences.maxRounds || 3 : 3);
      setHydrated(true);
    }).catch(() => {
      if (cancelled) return;
      const initial = makeConversation();
      setConversations([initial]);
      setActiveConversationId(initial.id);
      setConnectionMessage('이 기기의 대화 기록을 읽지 못했습니다. 새 대화를 시작합니다.');
      setHydrated(true);
    });
    return () => {
      cancelled = true;
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
    writeTimerRef.current = setTimeout(() => {
      const trimmed = [...conversations]
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_SAVED_CONVERSATIONS);
      void AsyncStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(trimmed)).catch(() => {});
    }, 350);
  }, [conversations, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const preferences: StoredPreferences = {
      apiBaseUrl,
      selectedModelKey,
      loopEnabled,
      maxRounds,
    };
    void AsyncStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences)).catch(() => {});
  }, [apiBaseUrl, hydrated, loopEnabled, maxRounds, selectedModelKey]);

  useEffect(() => {
    if (hydrated) void refreshModels(apiBaseUrl);
    // The saved backend is loaded once; explicit address changes refresh from the settings action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  useEffect(() => {
    if (activeConversation?.messages.length) {
      const timer = setTimeout(() => scrollRef.current?.scrollToEnd({animated: true}), 80);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [activeConversation?.messages.length]);

  async function refreshModels(url = apiBaseUrl): Promise<boolean> {
    setRefreshing(true);
    setConnectionState('checking');
    setConnectionMessage('로컬 서버에 연결 중');
    try {
      const base = normalizeLocalApiUrl(url);
      const result = await loadModelChoices(base);
      setModels(result.models);
      setConnectionCount(result.summary.connectedModels);
      setConnectionState('connected');
      setConnectionMessage(result.summary.connectedModels
        ? `${result.summary.connectedModels}개 모델 사용 가능`
        : '서버에 연결됨 · 사용 가능한 모델 없음');
      setSelectedModelKey(current => result.models.some(model => model.key === current)
        ? current
        : '');
      setSettingsError('');
      return true;
    } catch (error) {
      setModels([]);
      setConnectionCount(0);
      setConnectionState('offline');
      const message = error instanceof Error ? error.message : '서버 연결에 실패했습니다.';
      setConnectionMessage(message);
      setSettingsError(message);
      return false;
    } finally {
      setRefreshing(false);
    }
  }

  function patchConversation(id: string, update: (conversation: Conversation) => Conversation) {
    setConversations(current => current.map(conversation => conversation.id === id
      ? update(conversation)
      : conversation));
  }

  function patchAssistant(conversationId: string, messageId: string, update: (message: ChatMessage) => ChatMessage) {
    patchConversation(conversationId, conversation => ({
      ...conversation,
      updatedAt: Date.now(),
      messages: conversation.messages.map(message => message.id === messageId ? update(message) : message),
    }));
  }

  function newConversation() {
    if (busy) return;
    const conversation = makeConversation();
    setConversations(current => [conversation, ...current]);
    setActiveConversationId(conversation.id);
    setInput('');
    setExpandedRound('');
  }

  function updateRound(conversationId: string, messageId: string, roundNumber: number, update: (round: LoopRound) => LoopRound) {
    patchAssistant(conversationId, messageId, message => ({
      ...message,
      rounds: (message.rounds || []).map(round => round.number === roundNumber ? update(round) : round),
    }));
  }

  async function submitMessage() {
    const content = input.trim();
    const model = selectedModel;
    if (!content || !model || busy) return;
    if (connectionState !== 'connected') {
      setModal('settings');
      return;
    }

    let conversation = activeConversation;
    if (!conversation) {
      conversation = makeConversation();
      setConversations(current => [conversation as Conversation, ...current]);
      setActiveConversationId(conversation.id);
    }

    const userMessage: ChatMessage = {id: makeId(), role: 'user', content, createdAt: Date.now()};
    const assistantMessage: ChatMessage = {
      id: makeId(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      modelLabel: model.label,
      providerLabel: model.providerLabel,
      rounds: [],
      loopEnabled,
    };
    const title = conversation.messages.length === 0 ? shorten(content, 44) : conversation.title;
    const initialMessages = [...conversation.messages, userMessage, assistantMessage];
    patchConversation(conversation.id, current => ({
      ...current,
      title,
      updatedAt: Date.now(),
      messages: initialMessages,
    }));
    setInput('');
    setBusy(true);
    setActiveRound(0);
    setExpandedRound('');
    stopRequestedRef.current = false;

    const history = [...conversation.messages, userMessage]
      .slice(-MAX_CONTEXT_MESSAGES)
      .map(message => ({role: message.role, content: message.content.slice(0, 40_000) as string}));
    const roundLimit = loopEnabled ? maxRounds : 1;
    let accumulated = '';
    let completedRounds = 0;
    let stopped = false;
    let earlyComplete = false;
    let failure: string | null = null;
    let codexThreadId = conversation.codexThreadId;
    let codexAccountId = conversation.codexAccountId;

    for (let roundNumber = 1; roundNumber <= roundLimit; roundNumber += 1) {
      if (stopRequestedRef.current) {
        stopped = true;
        break;
      }
      setActiveRound(roundNumber);

      const instructions = loopEnabled
        ? [
            'Loop Engineering 실행 모드입니다. 사용자의 원래 요청과 앞선 회차 결과를 바탕으로 작업을 점진적으로 완성하세요.',
            `현재 회차: ${roundNumber}/${roundLimit}.`,
            roundNumber === 1
              ? '첫 회차에서는 요청을 분석하고 가능한 작업을 수행한 뒤, 확인한 결과와 남은 항목을 간결하게 설명하세요.'
              : '이번 회차에서는 앞선 결과를 확인하고 부족한 부분을 실제로 개선하거나 검증하세요. 이미 완료한 작업은 반복하지 마세요.',
            `목표가 완료되고 확인까지 끝났다면 응답 마지막에 ${LOOP_COMPLETE_MARKER}를 단독으로 출력해 조기 종료하세요. 완료되지 않았다면 출력하지 마세요.`,
          ].join('\n')
        : undefined;
      const context = roundNumber === 1
        ? history
        : [...history, {role: 'assistant' as const, content: accumulated}];
      const outboundMessages = context.slice(-MAX_CONTEXT_MESSAGES);
      const promptPreview = [
        instructions ? `Loop 지침\n${instructions}` : '',
        '모델에 전달한 대화 문맥',
        ...outboundMessages.slice(-6).map(message => `${message.role === 'user' ? '사용자' : 'AI'}: ${message.content.slice(0, 1_100)}`),
      ].filter(Boolean).join('\n\n').slice(0, 7_500);

      const round: LoopRound = {
        number: roundNumber,
        modelLabel: `${model.providerLabel} · ${model.label}`,
        status: 'running',
        promptPreview,
      };
      patchAssistant(conversation.id, assistantMessage.id, message => ({
        ...message,
        rounds: [...(message.rounds || []), round],
      }));

      let roundOutput = '';
      let prefix = accumulated ? `${accumulated}\n\n` : '';
      const selectedCodexAccountId = model.accountId || 'default';
      const canContinueCodexThread = model.provider === 'openai'
        && Boolean(codexThreadId)
        && (codexAccountId || 'default') === selectedCodexAccountId;
      const requestCodexAccountId = canContinueCodexThread
        ? codexAccountId || selectedCodexAccountId
        : selectedCodexAccountId;
      const reasoningEffort = loopEnabled && model.supportedReasoningEfforts?.includes('high')
        ? 'high'
        : loopEnabled && model.supportedReasoningEfforts?.includes('medium') ? 'medium' : undefined;
      const request = {
        provider: model.provider,
        model: model.id,
        ...(model.provider === 'api' && model.connectionId ? {connectionId: model.connectionId} : {}),
        ...(model.provider === 'openai' ? {codexAccountId: requestCodexAccountId} : {}),
        ...(model.provider === 'openai' && canContinueCodexThread && codexThreadId ? {codexThreadId} : {}),
        ...(reasoningEffort ? {reasoningEffort} : {}),
        ...(instructions ? {agentInstructions: instructions} : {}),
        messages: outboundMessages,
      };

      const stream = startChatStream(apiBaseUrl, request, {
        onDelta: value => {
          roundOutput += value;
          patchAssistant(conversation!.id, assistantMessage.id, message => ({
            ...message,
            content: `${prefix}${roundOutput}`,
          }));
        },
        onEvent: event => {
          if (event.name === 'thread' && typeof event.data.threadId === 'string') {
            codexThreadId = event.data.threadId;
            codexAccountId = typeof event.data.accountId === 'string'
              ? event.data.accountId
              : requestCodexAccountId;
            patchConversation(conversation!.id, current => ({
              ...current,
              codexThreadId,
              codexAccountId,
              updatedAt: Date.now(),
            }));
          }
          if (event.name === 'retry' && typeof event.data.accountId === 'string') {
            codexThreadId = undefined;
            codexAccountId = event.data.accountId;
            roundOutput = '';
            accumulated = '';
            prefix = '';
            patchConversation(conversation!.id, current => ({
              ...current,
              codexThreadId: undefined,
              codexAccountId,
              updatedAt: Date.now(),
            }));
            patchAssistant(conversation!.id, assistantMessage.id, message => ({...message, content: ''}));
          }
          if (event.name === 'progress' && typeof event.data.rollbackText === 'string') {
            const rollbackText = event.data.rollbackText;
            if (rollbackText && roundOutput.endsWith(rollbackText)) {
              roundOutput = roundOutput.slice(0, -rollbackText.length);
              patchAssistant(conversation!.id, assistantMessage.id, message => ({
                ...message,
                content: `${prefix}${roundOutput}`,
              }));
            }
          }
          if (event.name === 'activity') {
            const label = typeof event.data.title === 'string'
              ? event.data.title
              : typeof event.data.detail === 'string' ? event.data.detail : '서버 작업 진행 중';
            updateRound(conversation!.id, assistantMessage.id, roundNumber, item => ({...item, activity: label}));
          }
        },
      });
      activeStreamRef.current = stream;
      if (stopRequestedRef.current) stream.abort();

      try {
        await stream.promise;
        const cleanOutput = roundOutput.trimEnd();
        const completedWithMarker = cleanOutput.endsWith(LOOP_COMPLETE_MARKER);
        earlyComplete = earlyComplete || completedWithMarker;
        roundOutput = completedWithMarker
          ? cleanOutput.slice(0, -LOOP_COMPLETE_MARKER.length).trimEnd()
          : cleanOutput;
        accumulated = [accumulated, roundOutput].filter(Boolean).join('\n\n');
        completedRounds += 1;
        updateRound(conversation.id, assistantMessage.id, roundNumber, item => ({...item, status: 'completed'}));
        patchAssistant(conversation.id, assistantMessage.id, message => ({
          ...message,
          content: accumulated,
        }));

        if (!loopEnabled || completedWithMarker || roundNumber === roundLimit) {
          if (loopEnabled && completedWithMarker) {
            patchAssistant(conversation.id, assistantMessage.id, message => ({...message, loopLimitReached: false}));
          }
          break;
        }
      } catch (error) {
        const aborted = error instanceof Error && error.name === 'AbortError';
        stopped = aborted || stopRequestedRef.current;
        failure = stopped ? null : error instanceof Error ? error.message : 'AI 요청이 실패했습니다.';
        updateRound(conversation.id, assistantMessage.id, roundNumber, item => ({
          ...item,
          status: stopped ? 'stopped' : 'failed',
        }));
        if (roundOutput) accumulated = [accumulated, roundOutput].filter(Boolean).join('\n\n');
        break;
      } finally {
        activeStreamRef.current = null;
      }
    }

    const limitReached = loopEnabled && !earlyComplete && !stopped && !failure && completedRounds >= roundLimit;
    patchAssistant(conversation.id, assistantMessage.id, message => ({
      ...message,
      content: accumulated || (failure ? `오류: ${failure}` : stopped ? '응답을 중지했습니다.' : '응답이 비어 있습니다.'),
      stopped,
      error: failure || undefined,
      loopLimitReached: limitReached,
    }));
    setBusy(false);
    setActiveRound(0);
    stopRequestedRef.current = false;
  }

  function stopCurrentResponse() {
    if (!busy) return;
    stopRequestedRef.current = true;
    activeStreamRef.current?.abort();
  }

  function applyServerUrl() {
    try {
      const normalized = normalizeLocalApiUrl(settingsUrl);
      setApiBaseUrl(normalized);
      setSettingsUrl(normalized);
      setSettingsError('');
      void refreshModels(normalized).then(connected => {
        if (connected) setModal(null);
      });
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : '주소를 확인해 주세요.');
    }
  }

  function selectModel(model: ModelChoice) {
    setSelectedModelKey(model.key);
    setModal(null);
  }

  function deleteConversation(id: string) {
    if (busy) return;
    const remaining = conversations.filter(conversation => conversation.id !== id);
    const next = remaining.length ? remaining : [makeConversation()];
    setConversations(next);
    if (activeConversationId === id) setActiveConversationId(next[0].id);
  }

  const sortedConversations = useMemo(
    () => [...conversations].sort((left, right) => right.updatedAt - left.updatedAt),
    [conversations],
  );

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View style={styles.sidebar}>
        <View style={styles.brandRow}>
          <View style={styles.brandMark}><Text style={styles.brandGlyph}>∞</Text></View>
          <View>
            <Text style={styles.brandName}>Loopline</Text>
            <Text style={styles.brandCaption}>NATIVE WORKSPACE</Text>
          </View>
        </View>

        <Pressable accessibilityRole="button" onPress={newConversation} style={({pressed}) => [styles.newChatButton, pressed && styles.pressed]}>
          <Text style={styles.newChatGlyph}>＋</Text>
          <Text style={styles.newChatText}>새 대화</Text>
          <Text style={styles.shortcut}>⌘ N</Text>
        </Pressable>

        <Text style={styles.sectionLabel}>최근 대화</Text>
        <ScrollView style={styles.conversationList} contentContainerStyle={styles.conversationListContent}>
          {sortedConversations.map(conversation => {
            const selected = conversation.id === activeConversationId;
            return (
              <View key={conversation.id} style={[styles.conversationRow, selected && styles.conversationRowSelected]}>
                <Pressable onPress={() => setActiveConversationId(conversation.id)} style={styles.conversationSelect}>
                  <Text numberOfLines={1} style={[styles.conversationTitle, selected && styles.conversationTitleSelected]}>
                    {conversation.title || '새 대화'}
                  </Text>
                  <Text numberOfLines={1} style={styles.conversationMeta}>
                    {conversation.messages.length ? `${conversation.messages.length}개 메시지` : '비어 있음'}
                  </Text>
                </Pressable>
                <Pressable accessibilityLabel="대화 삭제" onPress={() => deleteConversation(conversation.id)} style={styles.deleteChatButton}>
                  <Text style={styles.deleteChatGlyph}>×</Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>

        <View style={styles.sidebarFooter}>
          <Pressable accessibilityRole="button" onPress={() => { setSettingsUrl(apiBaseUrl); setSettingsError(''); setModal('settings'); }} style={styles.serverStatusRow}>
            <View style={[styles.statusDot, connectionState === 'connected' ? styles.statusDotOnline : connectionState === 'checking' ? styles.statusDotChecking : styles.statusDotOffline]} />
            <View style={styles.serverStatusTextWrap}>
              <Text style={styles.serverStatusTitle}>
                {connectionState === 'connected' ? '로컬 서버 연결됨' : connectionState === 'checking' ? '서버 확인 중' : '서버 연결 필요'}
              </Text>
              <Text numberOfLines={1} style={styles.serverStatusSubtitle}>{connectionMessage}</Text>
            </View>
            <Text style={styles.settingsGlyph}>⚙</Text>
          </Pressable>
          <Text style={styles.sidebarFootnote}>대화와 설정은 이 Mac에 저장됩니다.</Text>
        </View>
      </View>

      <View style={styles.main}>
        <View style={styles.topBar}>
          <View style={styles.titleBlock}>
            <Text numberOfLines={1} style={styles.pageTitle}>{activeConversation?.title || '새 대화'}</Text>
            <Text style={styles.pageSubtitle}>기존 Loopline 서버와 로컬 연결</Text>
          </View>
          <View style={styles.topActions}>
            <Pressable onPress={() => void refreshModels()} style={({pressed}) => [styles.iconButton, pressed && styles.pressed]}>
              {refreshing ? <ActivityIndicator size="small" color={COLORS.textMuted} /> : <Text style={styles.iconButtonText}>↻</Text>}
            </Pressable>
            <Pressable onPress={() => { setSettingsUrl(apiBaseUrl); setSettingsError(''); setModal('settings'); }} style={({pressed}) => [styles.iconButton, pressed && styles.pressed]}>
              <Text style={styles.iconButtonText}>⚙</Text>
            </Pressable>
          </View>
        </View>

        <ScrollView ref={scrollRef} style={styles.messages} contentContainerStyle={styles.messagesContent}>
          {!activeConversation?.messages.length ? (
            <View style={styles.emptyState}>
              <View style={styles.emptyMark}><Text style={styles.emptyGlyph}>∞</Text></View>
              <Text style={styles.emptyTitle}>무엇을 함께 만들까요?</Text>
              <Text style={styles.emptyDescription}>연결된 Codex, Claude Code 또는 API 모델로 대화를 시작하세요.</Text>
              {!models.length && (
                <Pressable onPress={() => { setSettingsUrl(apiBaseUrl); setModal('settings'); }} style={styles.emptyConnectButton}>
                  <Text style={styles.emptyConnectText}>로컬 서버 연결 설정</Text>
                </Pressable>
              )}
            </View>
          ) : activeConversation.messages.map(message => (
            <View key={message.id} style={[styles.messageRow, message.role === 'user' ? styles.userMessageRow : styles.assistantMessageRow]}>
              {message.role === 'assistant' && (
                <View style={styles.assistantAvatar}><Text style={styles.assistantAvatarGlyph}>∞</Text></View>
              )}
              <View style={[styles.messageColumn, message.role === 'user' && styles.userMessageColumn]}>
                {message.role === 'assistant' && (
                  <View style={styles.messageMetaRow}>
                    <Text style={styles.messageAuthor}>Loopline</Text>
                    {message.modelLabel ? <Text style={styles.modelMeta}>{message.providerLabel} · {message.modelLabel}</Text> : null}
                    <Text style={styles.messageTime}>{formatTime(message.createdAt)}</Text>
                  </View>
                )}
                {message.role === 'user' ? (
                  <View style={styles.userBubble}><Text selectable style={styles.userText}>{message.content}</Text></View>
                ) : (
                  <View style={styles.assistantMessageBody}>
                    {message.content ? <Text selectable style={styles.assistantText}>{message.content}</Text> : busy && message.id === activeConversation.messages.at(-1)?.id ? (
                      <View style={styles.thinkingRow}><ActivityIndicator size="small" color={COLORS.accent} /><Text style={styles.thinkingText}>응답을 준비하고 있습니다…</Text></View>
                    ) : null}
                    {message.rounds?.length ? (
                      <View style={styles.roundPanel}>
                        <View style={styles.roundPanelHeader}>
                          <Text style={styles.roundPanelTitle}>{message.loopEnabled ? 'Loop 진행 내역' : '요청 정보'}</Text>
                          <Text style={styles.roundPanelCount}>{message.rounds.length}단계</Text>
                        </View>
                        {message.rounds.map(round => {
                          const roundKey = `${message.id}:${round.number}`;
                          const open = expandedRound === roundKey;
                          return (
                            <View key={round.number} style={styles.roundItem}>
                              <Pressable onPress={() => setExpandedRound(open ? '' : roundKey)} style={styles.roundRow}>
                                <View style={[styles.roundNumber, round.status === 'completed' && styles.roundNumberDone, round.status === 'failed' && styles.roundNumberFailed]}>
                                  <Text style={styles.roundNumberText}>{round.number}</Text>
                                </View>
                                <View style={styles.roundDetails}>
                                  <Text style={styles.roundTitle}>{message.loopEnabled ? `개선 회차 ${round.number}` : '모델 요청'}</Text>
                                  <Text style={styles.roundModel}>{round.modelLabel}{round.activity ? ` · ${round.activity}` : ''}</Text>
                                </View>
                                <Text style={[styles.roundStatus, round.status === 'failed' && styles.roundStatusFailed]}>{roundLabel(round)}</Text>
                                <Text style={styles.roundChevron}>{open ? '⌃' : '⌄'}</Text>
                              </Pressable>
                              {open && (
                                <View style={styles.roundPromptBox}>
                                  <Text style={styles.roundPromptLabel}>이 단계에서 전달한 요청 문맥</Text>
                                  <Text selectable style={styles.roundPromptText}>{round.promptPreview}</Text>
                                </View>
                              )}
                            </View>
                          );
                        })}
                        {message.loopLimitReached && <Text style={styles.roundFootnote}>설정한 최대 회차까지 진행했습니다. 더 개선하려면 대화를 이어가세요.</Text>}
                        {message.stopped && <Text style={styles.roundFootnote}>중지 요청을 반영했습니다. 확인된 응답은 보존했습니다.</Text>}
                        {message.error && <Text style={[styles.roundFootnote, styles.roundStatusFailed]}>{message.error}</Text>}
                      </View>
                    ) : null}
                  </View>
                )}
              </View>
            </View>
          ))}
        </ScrollView>

        <View style={styles.composerArea}>
          {busy && (
            <View style={styles.liveStatus}>
              <View style={styles.livePulse} />
              <Text style={styles.liveStatusText}>{loopEnabled ? `Loop 진행 중 · ${activeRound}/${maxRounds}회차` : '응답 생성 중'}</Text>
              <Pressable onPress={stopCurrentResponse} style={({pressed}) => [styles.stopButton, pressed && styles.pressed]}>
                <Text style={styles.stopButtonText}>중지</Text>
              </Pressable>
            </View>
          )}
          <View style={styles.composer}>
            <TextInput
              accessibilityLabel="메시지 입력"
              multiline
              onChangeText={setInput}
              onSubmitEditing={() => void submitMessage()}
              placeholder="작업이나 아이디어를 입력하세요"
              placeholderTextColor={COLORS.textDim}
              returnKeyType="send"
              style={styles.composerInput}
              value={input}
              editable={!busy}
            />
            <View style={styles.composerToolbar}>
              <View style={styles.composerOptions}>
                <Pressable onPress={() => setModal('models')} style={({pressed}) => [styles.modelPicker, pressed && styles.pressed]}>
                  <View style={styles.modelIcon}><Text style={styles.modelIconText}>{selectedModel ? providerInitial(selectedModel) : '＋'}</Text></View>
                  <View style={styles.modelPickerTextWrap}>
                    <Text style={styles.modelPickerLabel}>{selectedModel?.label || '모델 선택'}</Text>
                    <Text style={styles.modelPickerProvider}>{selectedModel?.providerLabel || '연결을 추가해 주세요'}</Text>
                  </View>
                  <Text style={styles.chevron}>⌄</Text>
                </Pressable>
                <View style={styles.toolbarDivider} />
                <Pressable onPress={() => setLoopEnabled(value => !value)} style={({pressed}) => [styles.loopToggle, loopEnabled && styles.loopToggleActive, pressed && styles.pressed]}>
                  <Text style={[styles.loopGlyph, loopEnabled && styles.loopGlyphActive]}>⟳</Text>
                  <Text style={[styles.loopToggleText, loopEnabled && styles.loopToggleTextActive]}>{loopEnabled ? 'Loop' : '한 번 실행'}</Text>
                </Pressable>
                {loopEnabled && (
                  <View style={styles.roundSelector}>
                    <Text style={styles.roundSelectorLabel}>최대</Text>
                    <Pressable accessibilityLabel="Loop 회차 줄이기" disabled={maxRounds <= ROUND_OPTIONS[0]} onPress={() => setMaxRounds(value => Math.max(ROUND_OPTIONS[0], value - 1))} style={styles.roundAdjustButton}>
                      <Text style={styles.roundAdjustText}>−</Text>
                    </Pressable>
                    <Text style={styles.roundSelectorValue}>{maxRounds}회</Text>
                    <Pressable accessibilityLabel="Loop 회차 늘리기" disabled={maxRounds >= ROUND_OPTIONS[ROUND_OPTIONS.length - 1]} onPress={() => setMaxRounds(value => Math.min(ROUND_OPTIONS[ROUND_OPTIONS.length - 1], value + 1))} style={styles.roundAdjustButton}>
                      <Text style={styles.roundAdjustText}>＋</Text>
                    </Pressable>
                  </View>
                )}
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="메시지 전송"
                disabled={!input.trim() || !selectedModel || busy}
                onPress={() => void submitMessage()}
                style={({pressed}) => [styles.sendButton, (!input.trim() || !selectedModel || busy) && styles.sendButtonDisabled, pressed && styles.pressed]}>
                <Text style={styles.sendButtonText}>↑</Text>
              </Pressable>
            </View>
          </View>
          <Text style={styles.composerHint}>모델과 대화 기록은 기존 Loopline 서버 및 이 Mac의 저장 공간을 사용합니다.</Text>
        </View>
      </View>

      <Modal transparent animationType="fade" visible={modal === 'models'} onRequestClose={() => setModal(null)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, styles.modelModal]}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalEyebrow}>MODEL SELECTOR</Text>
                <Text style={styles.modalTitle}>모델 선택</Text>
              </View>
              <Pressable accessibilityLabel="닫기" onPress={() => setModal(null)} style={styles.modalCloseButton}><Text style={styles.modalCloseText}>×</Text></Pressable>
            </View>
            <ScrollView style={styles.modelList} contentContainerStyle={styles.modelListContent}>
              {models.map(model => {
                const selected = selectedModel?.key === model.key;
                return (
                  <Pressable key={model.key} onPress={() => selectModel(model)} style={({pressed}) => [styles.modelOption, selected && styles.modelOptionSelected, pressed && styles.pressed]}>
                    <View style={[styles.modelOptionIcon, model.provider === 'openai' ? styles.codexIcon : model.provider === 'anthropic' ? styles.claudeIcon : styles.apiIcon]}>
                      <Text style={styles.modelOptionIconText}>{providerInitial(model)}</Text>
                    </View>
                    <View style={styles.modelOptionText}>
                      <Text style={styles.modelOptionTitle}>{model.label}</Text>
                      <Text style={styles.modelOptionSubtitle}>{model.providerLabel}{model.connectionName ? ` · ${model.connectionName}` : ''}{model.accountName ? ` · ${model.accountName}` : model.accountId && model.provider === 'openai' ? ` · ${model.accountId === 'default' ? '기본 계정' : `Codex 계정 ${model.accountId.slice(0, 8)}`}` : ''}</Text>
                    </View>
                    {selected && <Text style={styles.selectedCheck}>✓</Text>}
                  </Pressable>
                );
              })}
              {!models.length && (
                <View style={styles.noModels}>
                  <Text style={styles.noModelsTitle}>연결된 모델이 없습니다</Text>
                  <Text style={styles.noModelsText}>데스크톱 Loopline의 설정에서 Codex, Claude Code 또는 API 모델을 연결한 뒤 새로고침하세요.</Text>
                  <Pressable onPress={() => { setModal('settings'); setSettingsUrl(apiBaseUrl); }} style={styles.modalPrimaryButton}><Text style={styles.modalPrimaryText}>서버 연결 설정</Text></Pressable>
                </View>
              )}
            </ScrollView>
            <View style={styles.modalFooter}>
              <Text style={styles.modalFooterText}>{connectionCount}개 모델 · 연결된 계정 설정을 사용합니다</Text>
              <Pressable onPress={() => void refreshModels()} style={styles.refreshTextButton}><Text style={styles.refreshText}>새로고침</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal transparent animationType="fade" visible={modal === 'settings'} onRequestClose={() => setModal(null)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, styles.settingsModal]}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalEyebrow}>LOCAL CONNECTION</Text>
                <Text style={styles.modalTitle}>서버 연결</Text>
              </View>
              <Pressable accessibilityLabel="닫기" onPress={() => setModal(null)} style={styles.modalCloseButton}><Text style={styles.modalCloseText}>×</Text></Pressable>
            </View>
            <Text style={styles.settingsDescription}>기존 Loopline 서버에 로컬로 연결합니다. 앱은 네트워크에 서버를 공개하지 않습니다.</Text>
            <Text style={styles.inputLabel}>Loopline 서버 주소</Text>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={value => { setSettingsUrl(value); setSettingsError(''); }}
              placeholder="http://localhost:4173"
              placeholderTextColor={COLORS.textDim}
              style={styles.settingsInput}
              value={settingsUrl}
            />
            {settingsError ? <Text style={styles.settingsError}>{settingsError}</Text> : null}
            <View style={styles.localNotice}>
              <Text style={styles.localNoticeGlyph}>⌂</Text>
              <View style={styles.localNoticeCopy}>
                <Text style={styles.localNoticeTitle}>이 Mac의 로컬 연결만 허용</Text>
                <Text style={styles.localNoticeText}>다른 컴퓨터나 인터넷 주소는 허용되지 않습니다. 연결 전 데스크톱 앱에서 서버를 실행하세요.</Text>
              </View>
            </View>
            <View style={styles.settingsActions}>
              <Pressable onPress={() => void refreshModels(settingsUrl)} style={({pressed}) => [styles.secondaryButton, pressed && styles.pressed]}>
                <Text style={styles.secondaryButtonText}>{refreshing ? '확인 중…' : '연결 확인'}</Text>
              </Pressable>
              <Pressable disabled={refreshing} onPress={applyServerUrl} style={({pressed}) => [styles.modalPrimaryButton, refreshing && styles.disabledButton, pressed && styles.pressed]}>
                <Text style={styles.modalPrimaryText}>저장 후 연결</Text>
              </Pressable>
            </View>
            <Text style={styles.serverCommand}>서버 실행: 프로젝트 루트에서 npm start</Text>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const COLORS = {
  background: '#151515',
  sidebar: '#101010',
  panel: '#1d1d1d',
  panelRaised: '#242424',
  panelHover: '#2a2a2a',
  border: '#303030',
  text: '#f2f2f2',
  textMuted: '#b4b4b4',
  textDim: '#7e7e7e',
  accent: '#a9c8ff',
  accentDeep: '#5e91e8',
  green: '#79c99a',
  red: '#ed8d8d',
};

const styles = StyleSheet.create({
  root: {flex: 1, flexDirection: 'row', backgroundColor: COLORS.background, minHeight: 520, minWidth: 880},
  sidebar: {width: 264, backgroundColor: COLORS.sidebar, borderRightWidth: 1, borderRightColor: COLORS.border, paddingTop: 26, paddingHorizontal: 16, paddingBottom: 14},
  brandRow: {height: 54, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 5, marginBottom: 24},
  brandMark: {width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#26354b', borderWidth: 1, borderColor: '#3e5a7e'},
  brandGlyph: {fontSize: 27, color: COLORS.accent, lineHeight: 31, fontWeight: '500'},
  brandName: {color: COLORS.text, fontWeight: '700', fontSize: 16, letterSpacing: 0.2},
  brandCaption: {color: COLORS.textDim, fontSize: 9, letterSpacing: 1.45, marginTop: 3},
  newChatButton: {height: 43, borderRadius: 10, borderWidth: 1, borderColor: '#3b3b3b', backgroundColor: '#202020', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 9},
  newChatGlyph: {color: COLORS.textMuted, fontSize: 21, lineHeight: 24},
  newChatText: {color: COLORS.text, fontSize: 13, fontWeight: '600'},
  shortcut: {marginLeft: 'auto', color: COLORS.textDim, fontSize: 10},
  sectionLabel: {marginTop: 28, marginBottom: 9, paddingHorizontal: 7, color: COLORS.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 1},
  conversationList: {flex: 1},
  conversationListContent: {gap: 4},
  conversationRow: {minHeight: 55, borderRadius: 8, flexDirection: 'row', alignItems: 'center', paddingLeft: 10, paddingRight: 5},
  conversationRowSelected: {backgroundColor: '#292929'},
  conversationSelect: {flex: 1, paddingVertical: 9},
  conversationTitle: {color: '#b9b9b9', fontSize: 12},
  conversationTitleSelected: {color: COLORS.text, fontWeight: '600'},
  conversationMeta: {marginTop: 4, color: COLORS.textDim, fontSize: 10},
  deleteChatButton: {width: 28, height: 30, alignItems: 'center', justifyContent: 'center', opacity: 0.65},
  deleteChatGlyph: {color: COLORS.textDim, fontSize: 19},
  sidebarFooter: {borderTopWidth: 1, borderTopColor: '#272727', paddingTop: 12},
  serverStatusRow: {minHeight: 45, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 4},
  statusDot: {width: 8, height: 8, borderRadius: 5},
  statusDotOnline: {backgroundColor: COLORS.green},
  statusDotChecking: {backgroundColor: '#e0bd73'},
  statusDotOffline: {backgroundColor: COLORS.red},
  serverStatusTextWrap: {flex: 1},
  serverStatusTitle: {color: COLORS.textMuted, fontSize: 11, fontWeight: '600'},
  serverStatusSubtitle: {color: COLORS.textDim, fontSize: 9, marginTop: 3},
  settingsGlyph: {color: COLORS.textDim, fontSize: 15, paddingHorizontal: 3},
  sidebarFootnote: {marginTop: 9, paddingHorizontal: 4, color: '#686868', fontSize: 9},
  main: {flex: 1, minWidth: 0, backgroundColor: COLORS.background},
  topBar: {height: 76, borderBottomWidth: 1, borderBottomColor: '#292929', paddingHorizontal: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  titleBlock: {flex: 1, minWidth: 0},
  pageTitle: {color: COLORS.text, fontSize: 17, fontWeight: '600'},
  pageSubtitle: {color: COLORS.textDim, fontSize: 10, marginTop: 4},
  topActions: {flexDirection: 'row', gap: 8, marginLeft: 20},
  iconButton: {width: 34, height: 34, borderRadius: 9, borderWidth: 1, borderColor: '#393939', backgroundColor: '#202020', alignItems: 'center', justifyContent: 'center'},
  iconButtonText: {color: COLORS.textMuted, fontSize: 16},
  messages: {flex: 1},
  messagesContent: {flexGrow: 1, paddingVertical: 30, paddingHorizontal: 34, gap: 27},
  emptyState: {flex: 1, minHeight: 360, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30},
  emptyMark: {width: 62, height: 62, borderRadius: 21, backgroundColor: '#202c3b', borderWidth: 1, borderColor: '#344b6a', alignItems: 'center', justifyContent: 'center', marginBottom: 22},
  emptyGlyph: {fontSize: 45, color: COLORS.accent, lineHeight: 51},
  emptyTitle: {color: COLORS.text, fontSize: 23, fontWeight: '600', letterSpacing: -0.3},
  emptyDescription: {color: COLORS.textDim, fontSize: 13, marginTop: 10, textAlign: 'center', maxWidth: 400, lineHeight: 21},
  emptyConnectButton: {marginTop: 22, borderRadius: 9, borderWidth: 1, borderColor: '#4b4b4b', paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#222'},
  emptyConnectText: {color: COLORS.text, fontSize: 12, fontWeight: '600'},
  messageRow: {width: '100%', flexDirection: 'row', gap: 12, alignItems: 'flex-start'},
  userMessageRow: {justifyContent: 'flex-end'},
  assistantMessageRow: {justifyContent: 'flex-start'},
  assistantAvatar: {width: 28, height: 28, borderRadius: 9, backgroundColor: '#26354b', borderWidth: 1, borderColor: '#3b536f', alignItems: 'center', justifyContent: 'center', marginTop: 2},
  assistantAvatarGlyph: {color: COLORS.accent, fontSize: 20, lineHeight: 23},
  messageColumn: {maxWidth: '86%', minWidth: 180},
  userMessageColumn: {alignItems: 'flex-end'},
  messageMetaRow: {flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 8},
  messageAuthor: {color: COLORS.textMuted, fontSize: 11, fontWeight: '700'},
  modelMeta: {color: COLORS.textDim, fontSize: 10},
  messageTime: {color: '#696969', fontSize: 9},
  userBubble: {backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: '#353535', borderRadius: 15, borderTopRightRadius: 5, paddingHorizontal: 15, paddingVertical: 11},
  userText: {color: COLORS.text, fontSize: 13, lineHeight: 20},
  assistantMessageBody: {paddingTop: 1},
  assistantText: {color: '#e0e0e0', fontSize: 13, lineHeight: 21},
  thinkingRow: {flexDirection: 'row', alignItems: 'center', gap: 9, paddingVertical: 7},
  thinkingText: {color: COLORS.textDim, fontSize: 12},
  roundPanel: {marginTop: 15, borderWidth: 1, borderColor: '#303030', backgroundColor: '#191919', borderRadius: 12, overflow: 'hidden'},
  roundPanelHeader: {height: 38, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#292929'},
  roundPanelTitle: {color: '#d9d9d9', fontSize: 11, fontWeight: '700'},
  roundPanelCount: {marginLeft: 'auto', color: COLORS.textDim, fontSize: 10},
  roundItem: {borderBottomWidth: 1, borderBottomColor: '#262626'},
  roundRow: {minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 11, gap: 10},
  roundNumber: {width: 24, height: 24, borderRadius: 12, backgroundColor: '#303030', alignItems: 'center', justifyContent: 'center'},
  roundNumberDone: {backgroundColor: '#20392c'},
  roundNumberFailed: {backgroundColor: '#462727'},
  roundNumberText: {color: COLORS.textMuted, fontSize: 10, fontWeight: '700'},
  roundDetails: {flex: 1},
  roundTitle: {color: '#e3e3e3', fontSize: 11, fontWeight: '600'},
  roundModel: {color: COLORS.textDim, fontSize: 9, marginTop: 4},
  roundStatus: {color: COLORS.green, fontSize: 10},
  roundStatusFailed: {color: COLORS.red},
  roundChevron: {color: COLORS.textDim, fontSize: 16, paddingHorizontal: 2},
  roundPromptBox: {marginHorizontal: 11, marginBottom: 11, padding: 10, borderRadius: 8, backgroundColor: '#131313', borderWidth: 1, borderColor: '#2b2b2b'},
  roundPromptLabel: {color: COLORS.accent, fontSize: 9, fontWeight: '700', marginBottom: 7},
  roundPromptText: {color: '#b8b8b8', fontSize: 10, lineHeight: 16},
  roundFootnote: {color: COLORS.textDim, fontSize: 10, lineHeight: 15, paddingHorizontal: 12, paddingVertical: 10},
  composerArea: {paddingHorizontal: 28, paddingBottom: 14},
  liveStatus: {height: 34, flexDirection: 'row', alignItems: 'center', gap: 8},
  livePulse: {width: 7, height: 7, borderRadius: 5, backgroundColor: COLORS.accentDeep},
  liveStatusText: {color: COLORS.textMuted, fontSize: 11},
  stopButton: {marginLeft: 'auto', paddingHorizontal: 12, paddingVertical: 5, borderWidth: 1, borderColor: '#554040', borderRadius: 8, backgroundColor: '#302020'},
  stopButtonText: {color: '#e7a2a2', fontSize: 10, fontWeight: '700'},
  composer: {minHeight: 132, borderWidth: 1, borderColor: '#3a3a3a', borderRadius: 17, backgroundColor: '#222', paddingHorizontal: 15, paddingTop: 12, paddingBottom: 10},
  composerInput: {minHeight: 60, maxHeight: 128, color: COLORS.text, fontSize: 14, lineHeight: 21, padding: 0, textAlignVertical: 'top', outlineStyle: 'none'} as any,
  composerToolbar: {minHeight: 39, marginTop: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  composerOptions: {flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0},
  modelPicker: {minWidth: 170, maxWidth: 270, height: 38, borderRadius: 10, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8},
  modelIcon: {width: 25, height: 25, borderRadius: 8, backgroundColor: '#334967', alignItems: 'center', justifyContent: 'center'},
  modelIconText: {color: '#d7e5ff', fontSize: 11, fontWeight: '700'},
  modelPickerTextWrap: {flex: 1, minWidth: 0},
  modelPickerLabel: {color: COLORS.text, fontSize: 10, fontWeight: '600'},
  modelPickerProvider: {color: COLORS.textDim, fontSize: 9, marginTop: 2},
  chevron: {color: COLORS.textDim, fontSize: 15},
  toolbarDivider: {width: 1, height: 24, backgroundColor: '#3a3a3a'},
  loopToggle: {height: 34, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 9, borderWidth: 1, borderColor: 'transparent', borderRadius: 9},
  loopToggleActive: {borderColor: '#49678a', backgroundColor: '#243448'},
  loopGlyph: {color: COLORS.textDim, fontSize: 18},
  loopGlyphActive: {color: COLORS.accent},
  loopToggleText: {color: COLORS.textMuted, fontSize: 10, fontWeight: '600'},
  loopToggleTextActive: {color: '#d5e4fb'},
  roundSelector: {flexDirection: 'row', alignItems: 'center', gap: 5, borderLeftWidth: 1, borderLeftColor: '#3a3a3a', paddingLeft: 8},
  roundSelectorLabel: {color: COLORS.textDim, fontSize: 9},
  roundAdjustButton: {width: 22, height: 22, borderRadius: 7, backgroundColor: '#303030', alignItems: 'center', justifyContent: 'center'},
  roundAdjustText: {color: COLORS.textMuted, fontSize: 13, lineHeight: 15},
  roundSelectorValue: {color: COLORS.text, fontSize: 10, minWidth: 25, textAlign: 'center'},
  sendButton: {width: 38, height: 38, borderRadius: 13, backgroundColor: '#e8e8e8', alignItems: 'center', justifyContent: 'center', marginLeft: 12},
  sendButtonDisabled: {backgroundColor: '#555'},
  sendButtonText: {color: '#151515', fontSize: 22, fontWeight: '600', lineHeight: 26},
  composerHint: {color: '#626262', fontSize: 9, textAlign: 'center', marginTop: 8},
  modalBackdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.68)', alignItems: 'center', justifyContent: 'center', padding: 24},
  modalCard: {width: '100%', backgroundColor: '#202020', borderWidth: 1, borderColor: '#3a3a3a', borderRadius: 19, padding: 20, shadowColor: '#000', shadowOffset: {width: 0, height: 12}, shadowOpacity: 0.35, shadowRadius: 30, elevation: 12},
  modelModal: {maxWidth: 560, maxHeight: 610},
  settingsModal: {maxWidth: 540},
  modalHeader: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16},
  modalEyebrow: {color: '#8c8c8c', fontSize: 9, fontWeight: '700', letterSpacing: 1.5, marginBottom: 6},
  modalTitle: {color: COLORS.text, fontSize: 21, fontWeight: '700'},
  modalCloseButton: {width: 31, height: 31, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: '#2c2c2c'},
  modalCloseText: {color: COLORS.textMuted, fontSize: 21, lineHeight: 24},
  modelList: {maxHeight: 420},
  modelListContent: {gap: 6},
  modelOption: {minHeight: 59, borderRadius: 11, borderWidth: 1, borderColor: 'transparent', backgroundColor: '#272727', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 11, gap: 10},
  modelOptionSelected: {borderColor: '#536c8e', backgroundColor: '#293747'},
  modelOptionIcon: {width: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center'},
  codexIcon: {backgroundColor: '#273f38'},
  claudeIcon: {backgroundColor: '#463827'},
  apiIcon: {backgroundColor: '#3a3450'},
  modelOptionIconText: {color: '#e2e2e2', fontSize: 12, fontWeight: '700'},
  modelOptionText: {flex: 1},
  modelOptionTitle: {color: COLORS.text, fontSize: 12, fontWeight: '600'},
  modelOptionSubtitle: {color: COLORS.textDim, fontSize: 10, marginTop: 4},
  selectedCheck: {color: COLORS.accent, fontSize: 16, fontWeight: '700', paddingHorizontal: 5},
  modalFooter: {height: 42, borderTopWidth: 1, borderTopColor: '#343434', marginTop: 13, flexDirection: 'row', alignItems: 'flex-end'},
  modalFooterText: {color: COLORS.textDim, fontSize: 10},
  refreshTextButton: {marginLeft: 'auto', paddingVertical: 4, paddingHorizontal: 7},
  refreshText: {color: COLORS.accent, fontSize: 10, fontWeight: '600'},
  noModels: {paddingVertical: 30, paddingHorizontal: 22, alignItems: 'center'},
  noModelsTitle: {color: COLORS.text, fontSize: 14, fontWeight: '700'},
  noModelsText: {color: COLORS.textDim, fontSize: 11, lineHeight: 17, textAlign: 'center', marginTop: 9, maxWidth: 370},
  modalPrimaryButton: {minHeight: 37, borderRadius: 9, paddingHorizontal: 14, backgroundColor: '#e8e8e8', alignItems: 'center', justifyContent: 'center'},
  modalPrimaryText: {color: '#1b1b1b', fontSize: 11, fontWeight: '700'},
  settingsDescription: {color: COLORS.textMuted, fontSize: 12, lineHeight: 19, marginBottom: 20},
  inputLabel: {color: '#d1d1d1', fontSize: 11, fontWeight: '600', marginBottom: 8},
  settingsInput: {height: 43, borderWidth: 1, borderColor: '#454545', borderRadius: 9, backgroundColor: '#171717', color: COLORS.text, paddingHorizontal: 11, fontSize: 12},
  settingsError: {color: COLORS.red, fontSize: 10, marginTop: 7},
  localNotice: {marginTop: 16, borderRadius: 10, backgroundColor: '#182319', borderWidth: 1, borderColor: '#324639', padding: 12, flexDirection: 'row', gap: 10},
  localNoticeGlyph: {color: COLORS.green, fontSize: 19},
  localNoticeCopy: {flex: 1},
  localNoticeTitle: {color: '#d5eadb', fontSize: 11, fontWeight: '700'},
  localNoticeText: {color: '#9db3a3', fontSize: 10, lineHeight: 16, marginTop: 5},
  settingsActions: {marginTop: 18, flexDirection: 'row', justifyContent: 'flex-end', gap: 8},
  secondaryButton: {minHeight: 37, borderRadius: 9, paddingHorizontal: 13, borderWidth: 1, borderColor: '#4a4a4a', alignItems: 'center', justifyContent: 'center'},
  secondaryButtonText: {color: COLORS.textMuted, fontSize: 11, fontWeight: '600'},
  disabledButton: {opacity: 0.5},
  serverCommand: {color: '#777', fontSize: 10, marginTop: 14},
  pressed: {opacity: 0.74},
});
