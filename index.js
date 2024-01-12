require("dotenv").config();

const express = require("express");
const http = require("http");
const cookie = require("cookie");
const bodyParser = require("body-parser");
const cookieParser = require("cookie-parser");
const nunjucks = require("nunjucks");
const { nanoid } = require("nanoid");
const { pbkdf2Sync } = require("crypto");
const WebSocket = require("ws");

const knex = require("knex")({
  client: "pg",
  connection: {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  },
});

const app = express();

const hash = (d) => pbkdf2Sync(d, "salt", 100000, 64, "sha512").toString("hex");

const createUser = async (username, password) => {
  return await knex("users")
    .insert({
      username: username,
      password: hash(password),
    })
    .returning("id");
};

const findUserByUsername = async (username) =>
  knex("users")
    .select()
    .where({ username })
    .limit(1)
    .then((result) => result[0]);

const findUserBySessionId = async (sessionId) => {
  const session = await knex("sessions")
    .select("user_id")
    .where({ session_id: sessionId })
    .limit(1)
    .then((result) => result[0]);

  if (!session) {
    return;
  }

  return knex("users")
    .select()
    .where({ id: session.user_id })
    .limit(1)
    .then((result) => result[0]);
};

const createSession = async (userId) => {
  const sessionId = nanoid();

  await knex("sessions").insert({
    user_id: userId,
    session_id: sessionId,
  });

  return sessionId;
};

const deleteSesion = async (sessionId) => {
  await knex("sessions").where({ session_id: sessionId }).delete();
};

const createTimer = async (table, userId, description = "", timer = undefined) => {
  if (timer) {
    await knex(table).insert({
      user_id: userId,
      start: timer.start,
      end: Date.now().toString(),
      duration: timer.progress,
      description: timer.description,
    });
  } else {
    return await knex(table)
      .insert({
        user_id: userId,
        start: Date.now().toString(),
        progress: 0,
        description: description,
      })
      .returning("id");
  }
};

const findTimer = async (table, timersId) =>
  knex(table)
    .select()
    .where({ id: timersId })
    .limit(1)
    .then((result) => result[0]);

const findTimersByUserId = async (tableName, userId) =>
  knex(tableName)
    .select()
    .where({ user_id: userId })
    .orderBy("id", "desc")
    .then((result) => result);

const updateProgressTimer = async (timerId, progress) => {
  await knex("active_timers").where({ id: timerId }).update({
    progress: progress,
  });
};

const deleteTimer = async (table, timersId) => {
  await knex(table).where({ id: timersId }).delete();
};

const getActimeTimers = async (userId) => {
  const array = await findTimersByUserId("active_timers", userId);

  array.forEach(async (e) => {
    e.start = Number(e.start);
    e.progress = Date.now() - e.start;
    await updateProgressTimer(e.id, e.progress);
  });
  return array;
};

const getOldTimers = async (userId) => {
  const array = await findTimersByUserId("old_timers", userId);

  array.forEach(async (e) => {
    e.start = Number(e.start);
    e.end = Number(e.end);
  });

  return array;
};

nunjucks.configure("views", {
  autoescape: true,
  express: app,
  tags: {
    blockStart: "[%",
    blockEnd: "%]",
    variableStart: "[[",
    variableEnd: "]]",
    commentStart: "[#",
    commentEnd: "#]",
  },
});

app.set("view engine", "njk");
app.use(express.json());
app.use(express.static("public"));
app.use(cookieParser());

const server = http.createServer(app);

const wss = new WebSocket.Server({ clientTracking: false, noServer: true });
const clients = new Map();

const auth = () => async (req, res, next) => {
  if (!req.cookies["sessionId"]) {
    return next();
  }
  const user = await findUserBySessionId(req.cookies["sessionId"]);
  req.user = user;
  req.sessionId = req.cookies["sessionId"];
  next();
};

app.get("/", auth(), (req, res) => {
  res.render("index", {
    user: req.user,
    authError: req.query.authError,
  });
});

app.post("/login", bodyParser.urlencoded({ extended: false }), async (req, res) => {
  const { username, password } = req.body;
  const user = await findUserByUsername(username);

  if (!user) {
    return res.redirect("/?authError=Unknown%20username");
  }
  if (user.password !== hash(password)) {
    return res.redirect("/?authError=Wrong%20password");
  }

  const sessionId = await createSession(user.id);
  res.cookie("sessionId", sessionId, { httpOnly: true }).redirect("/");
});

app.post("/signup", bodyParser.urlencoded({ extended: false }), async (req, res) => {
  const { username, password } = req.body;
  const user = await findUserByUsername(username);
  if (user) {
    return res.redirect("/?authError=The%20user%20is%20already%20registered");
  }
  const newUserId = await createUser(username, password);
  const sessionId = await createSession(newUserId[0].id);
  res.cookie("sessionId", sessionId, { httpOnly: true }).redirect("/");
});

app.get("/logout", auth(), async (req, res) => {
  if (!req.user) {
    return res.redirect("/");
  }
  await deleteSesion(req.sessionId);

  wss.emit("close");
  res.clearCookie("sessionId").redirect("/");
});

const port = process.env.PORT || 3000;

server.on("upgrade", async (req, socket, head) => {
  const cookies = cookie.parse(req.headers["cookie"]);
  const token = cookies && cookies["sessionId"];
  const user = await findUserBySessionId(token);

  if (!user) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  req.user = user;

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  console.log("connection");
  const { user } = req;

  clients.set(user.id, ws);

  sendAllTimers(ws, user.id);

  setInterval(() => sendActiveTimers(ws, user.id), 1000);

  ws.on("close", () => {
    console.log("close");
    clients.delete(user.id);
  });

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (err) {
      return;
    }

    if (data.type === "createTimer") {
      createTimer("active_timers", user.id, data.description).then((timer) => {
        ws.send(
          JSON.stringify({
            type: "add_new_timers",
            timerId: timer[0].id,
            description: data.description,
          })
        );
        sendAllTimers(ws, user.id);
      });
    }

    if (data.type === "addOldTimer") {
      findTimer("active_timers", data.id).then((timer) => {
        deleteTimer("active_timers", data.id).then(() => {
          createTimer("old_timers", user.id, "", timer).then(() => {
            ws.send(
              JSON.stringify({
                type: "add_old_timers",
                timerId: data.id,
              })
            );

            sendAllTimers(ws, user.id);
          });
        });
      });
    }
  });
});

const sendAllTimers = async (ws, userId) => {
  ws.send(
    JSON.stringify({
      type: "all_timers",
      activeTimers: await getActimeTimers(userId),
      oldTimers: await getOldTimers(userId),
    })
  );
};

const sendActiveTimers = async (ws, userId) => {
  ws.send(
    JSON.stringify({
      type: "active_timers",
      activeTimers: await getActimeTimers(userId),
    })
  );
};

server.listen(port, () => {
  console.log(`  Listening on http://localhost:${port}`);
});
