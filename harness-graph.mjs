let graphRuntimePromise;

async function graphRuntime() {
  if (!graphRuntimePromise) {
    graphRuntimePromise = import('./langgraph-runtime.bundle.mjs').catch((error) => {
      if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      return import('@langchain/langgraph');
    });
  }
  return graphRuntimePromise;
}

export async function createHarnessWorkflow(handlers, { onNodeStart, onCheckpoint } = {}) {
  const { Annotation, END, MemorySaver, START, StateGraph } = await graphRuntime();
  const State = Annotation.Root({
    nextNode: Annotation({ default: () => 'select' }),
    completedRounds: Annotation({ default: () => 0 }),
    plan: Annotation({ default: () => '' }),
    files: Annotation({ default: () => '' }),
    previousSummary: Annotation({ default: () => '' }),
    feedback: Annotation({ default: () => '' }),
    reselectVerification: Annotation({ default: () => false }),
    decision: Annotation({ default: () => '' }),
    summary: Annotation({ default: () => '' }),
  });

  const node = (name, defaultNextNode, handler) => async (state) => {
    await onNodeStart?.(name, state);
    const output = await handler(state);
    const nextNode = output?.nextNode || defaultNextNode;
    const nextState = { ...state, ...(output || {}), nextNode };
    await onCheckpoint?.(nextNode, nextState);
    return { ...(output || {}), nextNode };
  };

  const destinations = {
    select: 'select',
    prepare: 'prepare',
    round: 'round',
    apply: 'apply',
    finish: 'finish',
    done: END,
  };
  const workflow = new StateGraph(State)
    .addNode('route', (state) => ({ nextNode: state.nextNode }))
    .addNode('select', node('select', 'prepare', handlers.select))
    .addNode('prepare', node('prepare', 'round', handlers.prepare))
    .addNode('round', node('round', 'round', handlers.round))
    .addNode('apply', node('apply', 'finish', handlers.apply))
    .addNode('finish', node('finish', 'done', handlers.finish))
    .addEdge(START, 'route')
    .addConditionalEdges('route', (state) => state.nextNode, destinations)
    .addEdge('select', 'prepare')
    .addEdge('prepare', 'round')
    .addConditionalEdges('round', (state) => state.nextNode, destinations)
    .addEdge('apply', 'finish')
    .addEdge('finish', END)
    .compile({ checkpointer: new MemorySaver() });

  return workflow;
}
