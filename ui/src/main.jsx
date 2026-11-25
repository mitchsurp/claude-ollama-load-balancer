import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import MobileApp from "./MobileApp.jsx";

const isMobileRoute = window.location.pathname === "/mobile" || window.location.pathname.startsWith("/mobile/");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {isMobileRoute ? <MobileApp /> : <App />}
  </React.StrictMode>
);
