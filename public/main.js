/*global UIkit, Vue */

let client = null;

const startWS = () => {
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  client = new WebSocket(`${wsProto}//${location.host}`);
  client.addEventListener("open", () => {});
};

const notification = (config) =>
  UIkit.notification({
    pos: "top-right",
    timeout: 5000,
    ...config,
  });

const info = (message) =>
  notification({
    message,
    status: "success",
  });

(() => {
  new Vue({
    el: "#app",
    data: {
      desc: "",
      activeTimers: [],
      oldTimers: [],
    },
    methods: {
      createTimer() {
        const description = this.desc;
        this.desc = "";
        client.send(
          JSON.stringify({
            type: "createTimer",
            description,
          })
        );
      },
      stopTimer(id) {
        client.send(
          JSON.stringify({
            type: "addOldTimer",
            id,
          })
        );
      },
      formatTime(ts) {
        return new Date(ts).toTimeString().split(" ")[0];
      },
      formatDuration(d) {
        d = Math.floor(d / 1000);
        const s = d % 60;
        d = Math.floor(d / 60);
        const m = d % 60;
        const h = Math.floor(d / 60);
        return [h > 0 ? h : null, m, s]
          .filter((x) => x !== null)
          .map((x) => (x < 10 ? "0" : "") + x)
          .join(":");
      },
    },
    created() {
      startWS();

      client.addEventListener("message", (message) => {
        let data;
        try {
          data = JSON.parse(message.data);
        } catch (err) {
          return;
        }

        if (data.type === "all_timers") {
          this.activeTimers = data.activeTimers;
          this.oldTimers = data.oldTimers;
        }

        if (data.type === "active_timers") {
          this.activeTimers = data.activeTimers;
        }

        if (data.type === "add_new_timers") {
          info(`Created new timer "${data.description}" [${data.timerId}]`);
        }

        if (data.type === "add_old_timers") {
          info(`Stopped the timer [${data.timerId}]`);
        }
      });
    },
  });
})();
