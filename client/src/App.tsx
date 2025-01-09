import React from 'react'
import './App.css'
import WebsiteEvolutionViewer from './WebsiteEvolutionViewer'

function App() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <main className="w-full max-w-md">
        <h1 className="text-3xl font-bold text-center mb-6">The Web Rewind</h1>
        <WebsiteEvolutionViewer />
      </main>
    </div>
  )
}

export default App
