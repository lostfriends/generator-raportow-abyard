import React from "react";
import { createRoot } from "react-dom/client";
import App from "./GeneratorRaportowABYARD";
const el = document.getElementById("root");
if (el) createRoot(el).render(React.createElement(App));
