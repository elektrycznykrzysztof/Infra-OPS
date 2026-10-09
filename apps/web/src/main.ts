import { createApp } from "vue";
import App from "./App.vue";
import { readThemePreference } from "./theme";
import "./styles.css";
import "@xterm/xterm/css/xterm.css";
document.documentElement.dataset.theme = readThemePreference();
createApp(App).mount("#app");
