import { Link, Outlet } from "react-router-dom";

import './Navigation.css'

const NavBar = () => {
  return (
    <div>
      <div className="nav-bar">
        <span>
          <Link to={`/`}>Home</Link>
        </span>
        <span>
          <Link to={`helpMeChoose/1`}>Help Me Choose</Link>
        </span>
        <span>
          <Link to={`restaurant/1`}>Restaurant Info</Link>
        </span>
        <span>
          <Link to={`userInfo/1`}>User Info</Link>
        </span>
        <span>
          <Link to={`userHistory/1`}>User History</Link>
        </span>
        <span>
          <Link to={`authentication`}>Sign In</Link>
        </span>
      </div>
      <Outlet />
    </div>
  )
}

export default NavBar;