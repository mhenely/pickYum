import React from 'react'
import ReactDOM from 'react-dom/client'
import {
  // BrowserRouter,
  createBrowserRouter,
  RouterProvider
} from 'react-router-dom';

import './index.css'

import App from './App.tsx'

import SearchPage from './routes/SearchPage.jsx';
import ErrorPage from './routes/ErrorPage'
import AuthenticationPage from './routes/AuthenticationPage'
import HelpMeChoosePage from './routes/HelpMeChoosePage'
import UserHistoryPage from './routes/UserHistoryPage'
import UserInfoPage from './routes/UserInfoPage'
import RestaurantPage from './routes/RestaurantPage';
// import Navigation from './components/Navigation'



const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    errorElement: <ErrorPage />,
    children: [
      { index: true, element: <SearchPage />},
      {
        path: 'choose/*',
        element: <HelpMeChoosePage />
      },
      {
        path: 'userHistory/:userId',
        element: <UserHistoryPage />
      },
      {
        path: 'userInfo/:userId',
        element: <UserInfoPage />
      },
      {
        path: 'restaurant/:restaurantId',
        element: <RestaurantPage />
      },
      {
        path: 'authentication',
        element: <AuthenticationPage />
      },
    ]
  }
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
      <RouterProvider router={router} />
  </React.StrictMode>,
)
