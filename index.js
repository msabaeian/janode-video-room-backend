import express from "express";
import http from "http";
import { Server } from "socket.io";
import Janode from "janode";
import VideoRoomPlugin from "janode/plugins/videoroom";
import cors from "cors";
const { Logger } = Janode;

let rooms = [];
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});
let janodeSession;
let janodeManagerHandle;

app.use(cors());
app.get("/", (req, res) => {
  res.send("Hello World!");
});

io.on("connection", (socket) => {
  const remote = `[${socket.request.connection.remoteAddress}:${socket.request.connection.remotePort}]`;
  console.log("a user connected");
  socket.emit("rooms", rooms);

  socket.on("rooms", () => {
    socket.emit("rooms", rooms);
  });

  socket.on("create_room", async (name) => {
    Logger.info(`${remote} create_room`);

    if (!checkSessions(janodeSession, janodeManagerHandle, socket)) return;

    try {
      const response = await janodeManagerHandle.create({
        max_publishers: 4,
        description: name
      });
      replyEvent(socket, 'room-created', response);
      Logger.info(`${remote} room-created`);
    } catch ({ message }) {
      replyError(socket, message, listdata, _id);
    }
    rooms.push(name);
    socket.emit("rooms", rooms);
    // TODO: create room using janus API
  });

  const clientHandles = (function () {
    let handles = [];

    return {
      insertHandle: (handle) => handles.push(handle),
      getHandleByFeed: (feed) => handles.find((h) => h.feed === feed),
      removeHandle: (handle) =>
        (handles = handles.filter((h) => h.id !== handle.id)),
      removeHandleByFeed: (feed) =>
        (handles = handles.filter((h) => h.feed !== feed)),
      leaveAll: () =>
        Promise.all(handles.map((h) => h.leave().catch(() => {}))),
      detachAll: () => {
        const detaches = handles.map((h) => h.detach().catch(() => {}));
        handles = [];
        return Promise.all(detaches);
      },
    };
  })();

  socket.on("join", async (evtdata = {}) => {
    Logger.info(`${remote} join received`);
    const { _id, data: joindata = {} } = evtdata;

    let pubHandle;

    try {
      if (!checkSessions(janodeSession, true, socket, evtdata)) return;

      pubHandle = await janodeSession.attach(VideoRoomPlugin);
      Logger.info(
        `${remote} videoroom publisher handle ${pubHandle.id} attached`
      );
      clientHandles.insertHandle(pubHandle);

      // Custom videoroom publisher/manager events
      pubHandle.on(VideoRoomPlugin.EVENT.VIDEOROOM_DESTROYED, (evtdata) => {
        console.log(`VideoRoomPlugin.EVENT.VIDEOROOM_DESTROYED ${evtdata}`);
        replyEvent(socket, "destroyed", evtdata);
      });
      pubHandle.on(VideoRoomPlugin.EVENT.VIDEOROOM_PUB_LIST, (evtdata) => {
        console.log(`VideoRoomPlugin.EVENT.VIDEOROOM_PUB_LIST ${evtdata}`);
        replyEvent(socket, "feed-list", evtdata);
      });
      pubHandle.on(
        VideoRoomPlugin.EVENT.VIDEOROOM_PUB_PEER_JOINED,
        (evtdata) => {
          console.log(
            `VideoRoomPlugin.EVENT.VIDEOROOM_PUB_PEER_JOINED ${evtdata}`
          );
          replyEvent(socket, "feed-joined", evtdata);
        }
      );

      pubHandle.on(
        VideoRoomPlugin.EVENT.VIDEOROOM_UNPUBLISHED,
        async (evtdata) => {
          const handle = clientHandles.getHandleByFeed(evtdata.feed);
          if (handle.feed !== pubHandle.feed) {
            clientHandles.removeHandleByFeed(evtdata.feed);
            await handle.detach().catch(() => {});
          }
          console.log(`VideoRoomPlugin.EVENT.VIDEOROOM_UNPUBLISHED ${evtdata}`);
          replyEvent(socket, "unpublished", evtdata);
        }
      );

      pubHandle.on(VideoRoomPlugin.EVENT.VIDEOROOM_LEAVING, async (evtdata) => {
        const handle = clientHandles.getHandleByFeed(evtdata.feed);
        clientHandles.removeHandleByFeed(evtdata.feed);
        if (handle) await handle.detach().catch(() => {});
        console.log(`VideoRoomPlugin.EVENT.VIDEOROOM_LEAVING ${evtdata}`);
        replyEvent(socket, "leaving", evtdata);
      });

      pubHandle.on(VideoRoomPlugin.EVENT.VIDEOROOM_DISPLAY, (evtdata) => {
        console.log(`VideoRoomPlugin.EVENT.VIDEOROOM_DISPLAY ${evtdata}`);
        replyEvent(socket, "display", evtdata);
      });
      pubHandle.on(VideoRoomPlugin.EVENT.VIDEOROOM_TALKING, (evtdata) => {
        console.log(`VideoRoomPlugin.EVENT.VIDEOROOM_TALKING ${evtdata}`);
        replyEvent(socket, "talking", evtdata);
      });

      pubHandle.on(VideoRoomPlugin.EVENT.VIDEOROOM_KICKED, async (evtdata) => {
        const handle = clientHandles.getHandleByFeed(evtdata.feed);
        clientHandles.removeHandleByFeed(evtdata.feed);
        if (handle) await handle.detach().catch(() => {});
        console.log(`VideoRoomPlugin.EVENT.VIDEOROOM_KICKED ${evtdata}`);
        replyEvent(socket, "kicked", evtdata);
      });

      // Generic videoroom events
      pubHandle.on(Janode.EVENT.HANDLE_WEBRTCUP, () => {
        console.log(`Janode.EVENT.HANDLE_WEBRTCUP ${JSON.stringify(evtdata)}`);
      });
      pubHandle.on(Janode.EVENT.HANDLE_MEDIA, (evtdata) =>
        Logger.info(`${pubHandle.name} media event ${JSON.stringify(evtdata)}`)
      );
      pubHandle.on(Janode.EVENT.HANDLE_SLOWLINK, (evtdata) =>
        Logger.info(
          `${pubHandle.name} slowlink event ${JSON.stringify(evtdata)}`
        )
      );
      pubHandle.on(Janode.EVENT.HANDLE_HANGUP, (evtdata) =>
        Logger.info(`${pubHandle.name} hangup event ${JSON.stringify(evtdata)}`)
      );
      pubHandle.on(Janode.EVENT.HANDLE_DETACHED, () => {
        Logger.info(`${pubHandle.name} detached event`);
        clientHandles.removeHandle(pubHandle);
      });
      pubHandle.on(Janode.EVENT.HANDLE_TRICKLE, (evtdata) =>
        Logger.info(
          `${pubHandle.name} trickle event ${JSON.stringify(evtdata)}`
        )
      );

      const response = await pubHandle.joinPublisher({
        room: joindata.room,
        display: joindata.display
      });
      replyEvent(socket, "joined", response, _id);
      Logger.info(`${remote} joined sent`);
    } catch ({ message }) {
      if (pubHandle) await pubHandle.detach().catch(() => {});
      console.log(`catch joindata ${JSON.stringify(joindata)}`);
    }
  });


  socket.on('configure', async (evtdata = {}) => {
    Logger.info(`${remote} configure received`);
    const { _id, data: confdata = {} } = evtdata;

    const handle = clientHandles.getHandleByFeed(confdata.feed);
    if (!checkSessions(janodeSession, handle, socket, evtdata)) return;

    try {
      const response = await handle.configure(confdata);
      delete response.configured;
      replyEvent(socket, 'configured', response, _id);
      Logger.info(`${remote} configured sent`);
    } catch ({ message }) {
      replyError(socket, message, confdata, _id);
    }
  });

  socket.on('subscribe', async (evtdata = {}) => {
    Logger.info(` ${remote} subscribe received`);
    const { _id, data: joindata = {} } = evtdata;

    if (!checkSessions(janodeSession, true, socket, evtdata)) return;

    let subHandle;

    try {
      subHandle = await janodeSession.attach(VideoRoomPlugin);
      Logger.info(` ${remote} videoroom listener handle ${subHandle.id} attached`);
      clientHandles.insertHandle(subHandle);

      // generic videoroom events
      subHandle.on(Janode.EVENT.HANDLE_WEBRTCUP, () => Logger.info(` ${subHandle.name} webrtcup event`));
      subHandle.on(Janode.EVENT.HANDLE_SLOWLINK, evtdata => Logger.info(` ${subHandle.name} slowlink event ${JSON.stringify(evtdata)}`));
      subHandle.on(Janode.EVENT.HANDLE_HANGUP, evtdata => Logger.info(` ${subHandle.name} hangup event ${JSON.stringify(evtdata)}`));
      subHandle.once(Janode.EVENT.HANDLE_DETACHED, () => {
        Logger.info(` ${subHandle.name} detached event`);
        clientHandles.removeHandle(subHandle);
      });
      subHandle.on(Janode.EVENT.HANDLE_TRICKLE, evtdata => Logger.info(` ${subHandle.name} trickle event ${JSON.stringify(evtdata)}`));


      // specific videoroom events
      subHandle.on(VideoRoomPlugin.EVENT.VIDEOROOM_SC_SUBSTREAM_LAYER, evtdata => Logger.info(` ${subHandle.name} simulcast substream layer switched to ${evtdata.sc_substream_layer}`));
      subHandle.on(VideoRoomPlugin.EVENT.VIDEOROOM_SC_TEMPORAL_LAYERS, evtdata => Logger.info(` ${subHandle.name} simulcast temporal layers switched to ${evtdata.sc_temporal_layers}`));

      const response = await subHandle.joinListener(joindata);

      replyEvent(socket, 'subscribed', response, _id);
      Logger.info(` ${remote} subscribed sent`);
    } catch ({ message }) {
      if (subHandle) await subHandle.detach().catch(() => { });
      replyError(socket, message, joindata, _id);
    }
  });

  socket.on('start', async (evtdata = {}) => {
    Logger.info(` ${remote} start received`);
    const { _id, data: startdata = {} } = evtdata;

    const handle = clientHandles.getHandleByFeed(startdata.feed);
    if (!checkSessions(janodeSession, handle, socket, evtdata)) return;

    try {
      const response = await handle.start(startdata); // Start a subscriber stream.
      replyEvent(socket, 'started', response, _id);
      Logger.info(` ${remote} started sent`);
    } catch ({ message }) {
      replyError(socket, message, startdata, _id);
    }
  });


  // trickle candidate from the client
  socket.on('trickle', async (evtdata = {}) => {
    Logger.info(` ${remote} trickle received`);
    const { _id, data: trickledata = {} } = evtdata;

    const handle = clientHandles.getHandleByFeed(trickledata.feed);
    if (!checkSessions(janodeSession, handle, socket, evtdata)) return;

    handle.trickle(trickledata.candidate).catch(({ message }) => replyError(socket, message, trickledata, _id));
  });

  // trickle complete signal from the client
  socket.on('trickle-complete', async (evtdata = {}) => {
    Logger.info(` ${remote} trickle-complete received`);
    const { _id, data: trickledata = {} } = evtdata;

    const handle = clientHandles.getHandleByFeed(trickledata.feed);
    if (!checkSessions(janodeSession, handle, socket, evtdata)) return;

    handle.trickleComplete(trickledata.candidate).catch(({ message }) => replyError(socket, message, trickledata, _id));
  });

  socket.on("disconnect", async () => {
    console.log("user disconnected");
    await clientHandles.leaveAll();
    await clientHandles.detachAll();
  });
});

async function bootJanode() {
  let connection = await Janode.connect({
    address: [
      {
        url: "ws://37.152.178.4:8188",
        apisecret: "secret",
      },
    ],
    retry_time_secs: 10,
  });

  connection.once(Janode.EVENT.CONNECTION_CLOSED, () => {
    Logger.info(`connection with Janus closed`);
  });

  connection.once(Janode.EVENT.CONNECTION_ERROR, (error) => {
    Logger.error(`connection with Janus error: ${error.message}`);
  });

  const session = await connection.create();
  Logger.info(`session ${session.id} with Janus created`);
  janodeSession = session;

  session.once(Janode.EVENT.SESSION_DESTROYED, () => {
    Logger.info(`session ${session.id} destroyed`);
    janodeSession = null;
  });

  const handle = await session.attach(VideoRoomPlugin);
  Logger.info(`manager handle ${handle.id} attached`);
  janodeManagerHandle = handle;

  // generic handle events
  handle.once(Janode.EVENT.HANDLE_DETACHED, () => {
    Logger.info(`${handle.name} manager handle detached event`);
  });
}
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  bootJanode();
  console.log(`Server is running on port ${PORT}`);
});


function replyEvent(socket, evtname, data, _id) {
  const evtdata = {
    data,
  };
  if (_id) evtdata._id = _id;

  socket.emit(evtname, evtdata);
}

function replyError(socket, message, request, _id) {
  const evtdata = {
    error: message,
  };
  if (request) evtdata.request = request;
  if (_id) evtdata._id = _id;

  socket.emit("videoroom-error", evtdata);
}

function checkSessions(session, handle, socket, { data, _id }) {
  if (!session) {
    replyError(socket, "session-not-available", data, _id);
    return false;
  }
  if (!handle) {
    replyError(socket, "handle-not-available", data, _id);
    return false;
  }
  return true;
}
