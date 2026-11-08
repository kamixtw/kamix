// generated from vendor/signals.js, do not edit
(function (Scratch) {
  "use strict";

  if (!Scratch.extensions.unsandboxed) {
    throw new Error("This extension must run unsandboxed!");
  }

  // extend.yml owns the extension id, but the compiled extension cannot read
  // the manifest, so it is repeated here. Keep the two in sync.
  const EXTENSION_ID = "signals";

  // Scratch composes an extension block's full opcode as
  // `<extension id>_<opcode>`, which is what startHats() looks up.
  const HAT_OPCODES = {
    whenActionReceived: `${EXTENSION_ID}_whenActionReceived`,
    whenQueryRequested: `${EXTENSION_ID}_whenQueryRequested`,
    whenEventEmitted: `${EXTENSION_ID}_whenEventEmitted`,
  };

  const DEFAULT_QUERY_TIMEOUT_MS = 2000;
  // setTimeout() treats a delay above this as 1 ms, so a longer timeout has to
  // be clamped to keep meaning "wait a long time".
  const MAX_TIMEOUT_MS = 2147483647;

  // Scratch's Thread statuses: 0 while the thread runs, 4 once it is done.
  // Anything else is parked on a yield or a promise.
  const THREAD_STATUS_RUNNING = 0;
  const THREAD_STATUS_DONE = 4;

  // How recently a hat predicate must have run for a hat whose NAME is not a
  // literal to count as a handler. Deliberately generous: a long frame or a
  // throttled background tab can pause the runtime for seconds, and a handler
  // thread can run for a while without the hat predicate running again.
  const HAT_FALLBACK_WINDOW_MS = 60 * 1000;

  const state = {
    currentData: null,
    errorState: {
      occurred: false,
      type: "",
      message: "",
    },
    registeredErrorTypes: new Set(["SignalsError", "Error"]),
    actionHandlers: new Map(),
    queryHandlers: new Map(),
    eventHandlers: new Map(),
    actionQueues: new Map(),
    eventQueues: new Map(),
    queryQueues: new Map(),
    queryCounter: 0,
    // A timeout of 0 waits until the handler returns.
    queryTimeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
    // queryId -> { resolve, settled, timer, thread }
    pendingQueries: new Map(),
    threadQueryId: new Map(),
    threadData: new Map(),
  };

  // Poll explicitly so consecutive queued signals do not need a false edge.
  let runtime = null;
  if (Scratch.vm && Scratch.vm.runtime) {
    runtime = Scratch.vm.runtime;
    runtime.on("BEFORE_EXECUTE", () => {
      settleFinishedQueryThreads();
      retireDispatchedEvents();
      runtime.startHats(HAT_OPCODES.whenActionReceived);
      runtime.startHats(HAT_OPCODES.whenQueryRequested);
      runtime.startHats(HAT_OPCODES.whenEventEmitted);
    });
  }

  // The hat block a predicate is running for. The runtime's block utility
  // exposes no block id, so the hat is the thread's top block.
  function getHatBlockId(util) {
    if (!util) return null;
    if (util.blockId) return util.blockId;
    const thread = util.thread;
    if (!thread) return null;
    if (thread.topBlock) return thread.topBlock;
    return typeof thread.peekStack === "function" ? thread.peekStack() : null;
  }

  // A clone copies its sprite's block ids, so a sprite and its clones all have
  // the same hat block id. A handler is identified by the target it runs in as
  // well as by its hat block, or the clones would look like one handler.
  function handlerId(target, blockId) {
    const targetId = target && target.id !== undefined ? String(target.id) : "";
    return `${targetId}:${blockId}`;
  }

  function getHandlerId(util) {
    const blockId = getHatBlockId(util);
    // No block id from the runtime means no target-scoped key either.
    if (blockId === null || blockId === undefined)
      return util ? util.thread : null;
    const target =
      (util && util.target) || (util && util.thread && util.thread.target);
    return handlerId(target, blockId);
  }

  function getHandlerTarget(util) {
    return (
      (util && util.target) ||
      (util && util.thread && util.thread.target) ||
      null
    );
  }

  function registerHandler(handlersMap, name, util) {
    let blockMap = handlersMap.get(name);
    if (!blockMap) {
      blockMap = new Map();
      handlersMap.set(name, blockMap);
    }
    const blockId = getHatBlockId(util);
    blockMap.set(getHandlerId(util), {
      timestamp: Date.now(),
      thread: util.thread || null,
      // A handler is identified by the target it runs in, so the target is
      // kept as well: once it is disposed the record can be recognised as dead
      // even though its id no longer matches anything in the runtime.
      target: getHandlerTarget(util),
      blockId: blockId === null || blockId === undefined ? null : blockId,
    });
  }

  function getBlock(target, blockId) {
    const blocks = target && target.blocks;
    if (!blocks || !blockId) return null;
    if (typeof blocks.getBlock === "function")
      return blocks.getBlock(blockId) || null;
    return (blocks._blocks && blocks._blocks[blockId]) || null;
  }

  // Top-level hat blocks of this opcode, keyed by handler id, across every target.
  function findHats(hatOpcode) {
    const hats = new Map();
    if (!runtime || !Array.isArray(runtime.targets)) return hats;
    for (const target of runtime.targets) {
      const blocks = target && target.blocks;
      if (!blocks || !Array.isArray(blocks._scripts)) continue;
      for (const blockId of blocks._scripts) {
        const block = getBlock(target, blockId);
        if (block && block.opcode === hatOpcode) {
          hats.set(handlerId(target, blockId), { target, block });
        }
      }
    }
    return hats;
  }

  // The name a hat is wired to, when that name is a literal. A reporter plugged
  // into the NAME slot can only be evaluated by the runtime, so it has none.
  // A saved project stores a block argument as a shadow block whose field is
  // named after the shadow's opcode ("TEXT"), not after the argument, so read
  // whatever single field the shadow holds.
  function getShadowValue(block) {
    if (!block || !block.fields) return null;
    for (const fieldName in block.fields) {
      const field = block.fields[fieldName];
      if (field && field.value !== undefined) return String(field.value);
    }
    return null;
  }

  // The name a hat is wired to, when that name is a literal. A reporter plugged
  // into the NAME slot can only be evaluated by the runtime, so it has none.
  function getLiteralName(target, block) {
    if (block.fields && block.fields.NAME) {
      const fieldValue = block.fields.NAME.value;
      return fieldValue === undefined ? null : String(fieldValue);
    }
    const input = block.inputs && block.inputs.NAME;
    if (!input) return null;
    if (input.block && input.shadow && input.block !== input.shadow)
      return null;
    const valueId = input.shadow || input.block;
    if (!valueId) return null;
    return getShadowValue(getBlock(target, valueId));
  }

  function isThreadRunning(record) {
    const thread = record && record.thread;
    if (!thread) return false;
    if (typeof thread.status === "number")
      return thread.status === THREAD_STATUS_RUNNING;
    return Array.isArray(runtime && runtime.threads)
      ? runtime.threads.includes(thread)
      : false;
  }

  // A record whose target has been disposed (a deleted clone, or every target
  // of the project that a long-lived runtime such as an editor's just loaded
  // over) or whose script has been deleted can never receive a signal again.
  // Senders must not count it: the timestamp fallback below would report a
  // second handler for up to HAT_FALLBACK_WINDOW_MS, and a recorded thread that
  // is still marked as running would keep doing so indefinitely.
  function isGoneHandler(record) {
    const target = record && record.target;
    // Nothing identifies the target, so there is nothing to check.
    if (!target) return false;
    if (
      Array.isArray(runtime && runtime.targets) &&
      runtime.targets.indexOf(target) === -1
    ) {
      return true;
    }
    const blocks = target.blocks;
    if (blocks && Array.isArray(blocks._scripts) && record.blockId) {
      return blocks._scripts.indexOf(record.blockId) === -1;
    }
    return false;
  }

  // The hat blocks that would receive a signal called `name`, across targets.
  function findHandlerBlocks(handlersMap, name, hatOpcode) {
    const hats = findHats(hatOpcode);
    const live = new Set();

    // Literal hats are read from the project itself, so a handler stays live
    // even when its predicate has not run recently.
    for (const [id, hat] of hats) {
      if (getLiteralName(hat.target, hat.block) === name) {
        live.add(id);
      }
    }

    const blockMap = handlersMap.get(name);
    if (!blockMap) return live;

    const now = Date.now();
    for (const [id, record] of blockMap) {
      if (live.has(id)) continue;
      const hat = hats.get(id);
      if (!hat) {
        // The hat is not in the runtime any more. Forget the record instead of
        // counting it, so a removed target cannot look like a second handler.
        if (isGoneHandler(record)) {
          blockMap.delete(id);
          continue;
        }
      } else {
        const literal = getLiteralName(hat.target, hat.block);
        if (literal !== null) {
          // A literal name that does not match can never receive this signal.
          if (!isThreadRunning(record)) blockMap.delete(id);
          continue;
        }
      }
      if (isThreadRunning(record)) {
        live.add(id);
      } else if (now - record.timestamp < HAT_FALLBACK_WINDOW_MS) {
        live.add(id);
      } else {
        blockMap.delete(id);
      }
    }

    return live;
  }

  function getActiveHandlerCount(handlersMap, name, hatOpcode) {
    return findHandlerBlocks(handlersMap, name, hatOpcode).size;
  }

  // An event is broadcast: every handler gets the same data. A delivery is
  // retired once every live handler has taken it, so a handler that is still
  // running takes it as soon as it is free instead of missing it. A delivery
  // nobody can take (there is no live handler) is dropped after one poll.
  function retireDispatchedEvents() {
    for (const [name, queue] of state.eventQueues) {
      if (queue.length === 0) continue;
      const live = findHandlerBlocks(
        state.eventHandlers,
        name,
        HAT_OPCODES.whenEventEmitted,
      );
      while (queue.length > 0) {
        const head = queue[0];
        if (live.size === 0) {
          head.polls += 1;
          if (head.polls <= 1) break;
          queue.shift();
          continue;
        }
        let servedByEveryone = true;
        for (const blockId of live) {
          if (!head.served.has(blockId)) {
            servedByEveryone = false;
            break;
          }
        }
        if (!servedByEveryone) break;
        queue.shift();
      }
    }
  }

  function clearErrorStateInternal() {
    state.errorState = {
      occurred: false,
      type: "",
      message: "",
    };
  }

  function raiseErrorInternal(type, message) {
    const validType = state.registeredErrorTypes.has(type)
      ? type
      : "SignalsError";
    const validMessage = state.registeredErrorTypes.has(type)
      ? message
      : `Unregistered error type '${type}': ${message}`;
    state.errorState = {
      occurred: true,
      type: validType,
      message: validMessage,
    };
  }

  // Each query is settled at most once: the handler's return value, its error,
  // or the timeout, whichever happens first.
  function settleQuery(queryId, value) {
    const pending = state.pendingQueries.get(queryId);
    if (!pending || pending.settled) return false;
    pending.settled = true;
    state.pendingQueries.delete(queryId);
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    pending.resolve(value);
    return true;
  }

  // Forgets the query a handler thread is answering and hands back its id, if
  // any, so the caller can settle it.
  function takePendingQuery(thread) {
    if (thread === undefined || thread === null) return undefined;
    const queryId = state.threadQueryId.get(thread);
    if (queryId !== undefined) {
      state.threadQueryId.delete(thread);
      state.threadData.delete(thread);
    }
    return queryId;
  }

  function abandonPendingQuery(util) {
    const queryId = takePendingQuery(util && util.thread);
    if (queryId !== undefined) {
      settleQuery(queryId, "");
    }
  }

  function isThreadFinished(thread) {
    return (
      !!thread &&
      typeof thread.status === "number" &&
      thread.status === THREAD_STATUS_DONE
    );
  }

  // A handler script that ends without running `return value` never settles its
  // query on its own, so settle it once its thread is done instead of waiting
  // out the timeout.
  function settleFinishedQueryThreads() {
    for (const [queryId, pending] of state.pendingQueries) {
      if (!pending.settled && isThreadFinished(pending.thread)) {
        settleQuery(queryId, "");
      }
    }
  }

  class SignalsExtension {
    getInfo() {
      return {
        id: "signals",
        name: "Signals",
        color1: "#5974bf",
        menus: {
          errorTypeMenu: {
            items: "_getErrorTypes",
          },
        },
        blocks: [
          {
            opcode: "whenActionReceived",
            blockType: Scratch.BlockType.HAT,
            text: "when action [NAME] received",
            isEdgeActivated: false,
            arguments: {
              NAME: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "RegistryAPI.write",
              },
            },
          },
          {
            opcode: "whenQueryRequested",
            blockType: Scratch.BlockType.HAT,
            text: "when query [NAME] requested",
            isEdgeActivated: false,
            arguments: {
              NAME: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "RegistryAPI.read",
              },
            },
          },
          {
            opcode: "whenEventEmitted",
            blockType: Scratch.BlockType.HAT,
            text: "when event [NAME] emitted",
            isEdgeActivated: false,
            arguments: {
              NAME: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "WindowManager.onResize",
              },
            },
          },
          {
            opcode: "returnValue",
            blockType: Scratch.BlockType.COMMAND,
            text: "return value [VALUE]",
            isTerminal: true,
            arguments: {
              VALUE: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "0",
              },
            },
          },
          "---",
          {
            opcode: "fireAction",
            blockType: Scratch.BlockType.COMMAND,
            text: "fire action [NAME] with data [DATA]",
            arguments: {
              NAME: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "RegistryAPI.write",
              },
              DATA: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: '{"key": "value"}',
              },
            },
          },
          {
            opcode: "querySignal",
            blockType: Scratch.BlockType.REPORTER,
            text: "query [NAME] with data [DATA]",
            arguments: {
              NAME: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "RegistryAPI.read",
              },
              DATA: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: '{"key": "value"}',
              },
            },
          },
          {
            opcode: "setQueryTimeout",
            blockType: Scratch.BlockType.COMMAND,
            text: "set query timeout (ms) [MS]",
            arguments: {
              MS: {
                type: Scratch.ArgumentType.NUMBER,
                defaultValue: 2000,
              },
            },
          },
          {
            opcode: "emitEvent",
            blockType: Scratch.BlockType.COMMAND,
            text: "emit event [NAME] with data [DATA]",
            arguments: {
              NAME: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "WindowManager.onResize",
              },
              DATA: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: '{"width": 800}',
              },
            },
          },
          {
            opcode: "getSignalData",
            blockType: Scratch.BlockType.REPORTER,
            text: "signal data",
          },
          "---",
          {
            opcode: "raiseError",
            blockType: Scratch.BlockType.COMMAND,
            text: "raise error [TYPE] message [MESSAGE]",
            isTerminal: true,
            arguments: {
              TYPE: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "SignalsError",
                menu: "errorTypeMenu",
              },
              MESSAGE: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "Something went wrong.",
              },
            },
          },
          {
            opcode: "didErrorOccur",
            blockType: Scratch.BlockType.BOOLEAN,
            text: "did error occur?",
          },
          {
            opcode: "lastErrorType",
            blockType: Scratch.BlockType.REPORTER,
            text: "last error type",
          },
          {
            opcode: "lastErrorMessage",
            blockType: Scratch.BlockType.REPORTER,
            text: "last error message",
          },
          {
            opcode: "clearErrorState",
            blockType: Scratch.BlockType.COMMAND,
            text: "clear error state",
          },
          {
            opcode: "registerErrorType",
            blockType: Scratch.BlockType.COMMAND,
            text: "register error type [TYPE]",
            arguments: {
              TYPE: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "CustomError",
              },
            },
          },
          {
            opcode: "unregisterErrorType",
            blockType: Scratch.BlockType.COMMAND,
            text: "unregister error type [TYPE]",
            arguments: {
              TYPE: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: "CustomError",
              },
            },
          },
        ],
      };
    }

    _getErrorTypes() {
      const types = Array.from(state.registeredErrorTypes);
      return types.length > 0 ? types : ["SignalsError"];
    }

    whenActionReceived(args, util) {
      registerHandler(state.actionHandlers, args.NAME, util);
      const queue = state.actionQueues.get(args.NAME);
      if (queue && queue.length > 0) {
        state.threadData.set(util.thread, queue.shift());
        return true;
      }
      return false;
    }

    whenQueryRequested(args, util) {
      registerHandler(state.queryHandlers, args.NAME, util);
      const queue = state.queryQueues.get(args.NAME);
      if (queue && queue.length > 0) {
        while (queue.length > 0) {
          const request = queue.shift();
          const pending = request
            ? state.pendingQueries.get(request.id)
            : undefined;
          if (pending && !pending.settled) {
            pending.thread = util.thread || null;
            state.threadQueryId.set(util.thread, request.id);
            state.threadData.set(util.thread, request.data);
            return true;
          }
        }
      }
      return false;
    }

    whenEventEmitted(args, util) {
      registerHandler(state.eventHandlers, args.NAME, util);
      const queue = state.eventQueues.get(args.NAME);
      if (!queue) return false;
      // An event is broadcast: every handler takes each emission exactly once. A
      // delivery is not retired until every live handler has taken it, so a
      // handler that was still running when the event arrived takes it from the
      // queue as soon as it is free. A handler skips the deliveries it already
      // took, so one slow handler does not hold up the others.
      const handler = getHandlerId(util);
      for (const delivery of queue) {
        if (delivery.served.has(handler)) continue;
        delivery.served.add(handler);
        state.threadData.set(util.thread, delivery.data);
        return true;
      }
      return false;
    }

    returnValue(args, util) {
      const queryId = takePendingQuery(util && util.thread);
      if (queryId !== undefined) {
        settleQuery(queryId, args.VALUE);
      }
      if (util) {
        if (typeof util.stopThread === "function") {
          return util.stopThread();
        }
        if (util.thread && typeof util.thread.stopThisScript === "function") {
          util.thread.stopThisScript();
        }
      }
    }

    fireAction(args) {
      // did error occur? describes this signal, not the one before it.
      clearErrorStateInternal();
      const name = args.NAME;
      const count = getActiveHandlerCount(
        state.actionHandlers,
        name,
        HAT_OPCODES.whenActionReceived,
      );

      if (count === 0) {
        raiseErrorInternal("SignalsError", "This action/query has no handler.");
        return;
      }
      if (count >= 2) {
        raiseErrorInternal("SignalsError", "Action has multiple handlers.");
        return;
      }

      if (!state.actionQueues.has(name)) {
        state.actionQueues.set(name, []);
      }
      state.actionQueues.get(name).push(args.DATA);
      try {
        if (runtime) {
          runtime.startHats(HAT_OPCODES.whenActionReceived);
        }
      } catch (e) {
        raiseErrorInternal(
          "SignalsError",
          e && e.message ? e.message : String(e),
        );
      }
    }

    querySignal(args) {
      // did error occur? describes this signal, not the one before it.
      clearErrorStateInternal();
      const name = args.NAME;
      const count = getActiveHandlerCount(
        state.queryHandlers,
        name,
        HAT_OPCODES.whenQueryRequested,
      );

      if (count === 0) {
        raiseErrorInternal("SignalsError", "This action/query has no handler.");
        return Promise.resolve("");
      }
      if (count >= 2) {
        raiseErrorInternal("SignalsError", "Query has multiple handlers.");
        return Promise.resolve("");
      }

      const queryId = ++state.queryCounter;
      if (!state.queryQueues.has(name)) {
        state.queryQueues.set(name, []);
      }
      state.queryQueues.get(name).push({ id: queryId, data: args.DATA });

      const timeoutMs = state.queryTimeoutMs;

      return new Promise((resolve) => {
        const pending = { resolve, settled: false, timer: null, thread: null };
        state.pendingQueries.set(queryId, pending);

        if (timeoutMs > 0) {
          pending.timer = setTimeout(() => {
            // A result or error already reached the caller; never overwrite it.
            if (!state.pendingQueries.has(queryId)) return;
            raiseErrorInternal(
              "SignalsError",
              `Query '${name}' did not return a value within ${timeoutMs} ms.`,
            );
            settleQuery(queryId, "");
          }, timeoutMs);
        }

        try {
          if (runtime) {
            runtime.startHats(HAT_OPCODES.whenQueryRequested);
          }
        } catch (e) {
          raiseErrorInternal(
            "SignalsError",
            e && e.message ? e.message : String(e),
          );
          const queue = state.queryQueues.get(name);
          if (queue) {
            const index = queue.findIndex((request) => request.id === queryId);
            if (index !== -1) {
              queue.splice(index, 1);
            }
          }
          settleQuery(queryId, "");
        }
      });
    }

    setQueryTimeout(args) {
      const raw = args.MS;
      const value = typeof raw === "string" ? raw.trim() : raw;
      const ms = Math.floor(Number(value));
      // A blank value converts to 0, which would silently disable the timeout
      // instead of reporting the empty input.
      if (value === "" || !Number.isFinite(ms) || ms < 0) {
        raiseErrorInternal(
          "SignalsError",
          `Invalid query timeout '${args.MS}': expected a number of milliseconds, or 0 to disable the timeout.`,
        );
        return;
      }
      // Longer delays overflow setTimeout() and fire almost immediately.
      state.queryTimeoutMs = Math.min(ms, MAX_TIMEOUT_MS);
    }

    emitEvent(args) {
      // did error occur? describes this event, not the one before it.
      clearErrorStateInternal();
      const name = args.NAME;
      if (!state.eventQueues.has(name)) {
        state.eventQueues.set(name, []);
      }
      state.eventQueues
        .get(name)
        .push({ data: args.DATA, served: new Set(), polls: 0 });
      try {
        if (runtime) {
          runtime.startHats(HAT_OPCODES.whenEventEmitted);
        }
      } catch (e) {
        raiseErrorInternal(
          "SignalsError",
          e && e.message ? e.message : String(e),
        );
      }
    }

    getSignalData(args, util) {
      if (state.threadData.has(util.thread)) {
        return state.threadData.get(util.thread);
      }
      return state.currentData !== null ? state.currentData : "";
    }

    raiseError(args, util) {
      const type = args.TYPE || "Error";
      const message = args.MESSAGE || "An error occurred.";
      raiseErrorInternal(type, message);
      // The caller of a query must not wait out the timeout when its handler stops
      // with an error. Settle it now; didErrorOccur() keeps the handler's error.
      abandonPendingQuery(util);
      if (util) {
        if (typeof util.stopThread === "function") {
          return util.stopThread();
        }
        if (util.thread && typeof util.thread.stopThisScript === "function") {
          util.thread.stopThisScript();
        }
      }
    }

    didErrorOccur() {
      return state.errorState.occurred;
    }

    lastErrorType() {
      return state.errorState.type;
    }

    lastErrorMessage() {
      return state.errorState.message;
    }

    clearErrorState() {
      clearErrorStateInternal();
    }

    registerErrorType(args) {
      if (args.TYPE) {
        state.registeredErrorTypes.add(args.TYPE);
      }
    }

    unregisterErrorType(args) {
      const type = args.TYPE;
      if (type && type !== "SignalsError" && type !== "Error") {
        state.registeredErrorTypes.delete(type);
      }
    }
  }

  Scratch.extensions.register(new SignalsExtension());
})(Scratch);
