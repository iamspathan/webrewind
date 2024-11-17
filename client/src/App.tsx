import { Button } from "./components/ui/button.tsx";
import "./styles.css";
import React, { useEffect } from "react";

function App() {
  // useEffect(() => {
  //   fetch("/test")
  //     .then((res) => res.json())
  //     .then((data) => console.log(data));
  // }, []);

  return (
    <div className="App">
      <Button  variant={"outline"}>Click me</Button>
      <div>
      </div>
      <header className="App-header">
        <a
          className="App-link"
          href="https://reactjs.org"
          target="_blank"
          rel="noopener noreferrer"
        >
          Webrewind
        </a>
      </header>
    </div>
  );
}

export default App;
