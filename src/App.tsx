import { Provider } from 'react-redux';

import Navigation from './components/Navigation'
import store from './redux/store.js'
// import store from './redux/practiceStore'

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
