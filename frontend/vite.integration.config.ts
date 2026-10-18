import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// A package uses the exact React instance supplied by Core, including JSX runtime.
// Importing another copy would break hooks when host UI and module UI compose.
function hostRuntime(): Plugin {
  const modules = ["react", "react/jsx-runtime", "react-dom", "react-dom/client"];
  return {
    name: "homenet-host-runtime", enforce: "pre",
    resolveId(id) { return modules.includes(id) ? `\0homenet:${id}` : undefined; },
    load(id) {
      if (!id.startsWith("\0homenet:")) return;
      const name = id.slice("\0homenet:".length);
      if (name === "react/jsx-runtime") return `const R=globalThis.__HOMENET_RUNTIME__.React;export const Fragment=R.Fragment;export function jsx(type,props,key){return R.createElement(type,key===undefined?props:{...props,key});}export const jsxs=jsx;`;
      if (name === "react-dom") return `const H=globalThis.__HOMENET_RUNTIME__;export function createPortal(children,container,key){return H.ReactDOM.createPortal(children,container===document.body?H.portalTarget:container,key);}export const flushSync=H.ReactDOM.flushSync;`;
      const keys = name === "react" ? ["Children", "Component", "PureComponent", "Fragment", "StrictMode", "Suspense", "cloneElement", "createContext", "createElement", "createRef", "forwardRef", "isValidElement", "lazy", "memo", "startTransition", "useCallback", "useContext", "useDebugValue", "useDeferredValue", "useEffect", "useId", "useImperativeHandle", "useInsertionEffect", "useLayoutEffect", "useMemo", "useReducer", "useRef", "useState", "useSyncExternalStore", "useTransition", "version"] : name === "react-dom/client" ? ["createRoot"] : ["createPortal", "flushSync"];
      const property = name === "react" ? "React" : name === "react-dom/client" ? "ReactDOMClient" : "ReactDOM";
      return `const R=globalThis.__HOMENET_RUNTIME__.${property};export default R;${keys.map(k => `export const ${k}=R.${k};`).join("")}`;
    },
  };
}
export default defineConfig(({ mode }) => {
  if (!["proxy", "network", "vpn", "pve"].includes(mode)) throw new Error("Choose --mode proxy, network, vpn or pve");
  return { plugins: [hostRuntime(), react()], base: "./", css: { postcss: { plugins: [{ postcssPlugin: "homenet-shadow-css", Rule(rule) {
    rule.selector = rule.selector.replace(/:root\[data-theme="dark"\]/g, ':host([data-theme="dark"])').replace(/:root/g, ":host").replace(/^html\b/g, ":host").replace(/^body\b/g, ".homenet-module-root");
  } }] } }, build: {
    outDir: `static/integrations/${mode}`, emptyOutDir: true,
    lib: { entry: `src/platform/${mode}.tsx`, formats: ["es"], fileName: () => "entry.js", cssFileName: "style" },
  } };
});
