import { Provider } from 'react-redux';
import './App.styles.css'
import Navigation from './components/Navigation'
import store from './redux/store.js'

function App() {

  return (
    <>
    <Provider store={store}>
      <Navigation />
    </Provider>
    </>
  )
}

export default App
