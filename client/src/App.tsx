import React from 'react'
import './App.css'
import URLYearPickerWith3D from './url-year-picker-3d'

function App() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <main className="w-full max-w-md">
        <h1 className="text-3xl font-bold text-center mb-6">URL Year Picker</h1>
        <URLYearPickerWith3D />
      </main>
    </div>
  )
}

export default App
