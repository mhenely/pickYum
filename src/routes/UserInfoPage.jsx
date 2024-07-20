import { useSelector, useDispatch } from "react-redux";
import { useRef } from "react";

import { updateUserInfo } from "../redux/slices/userInfoSlice";

const UserInfoPage = () => {

  const userInfo = useSelector(state => state.userInfo.users[0]);

  console.log({ userInfo })

  const dispatch = useDispatch();

  const usernameRef = useRef();
  const passwordRef = useRef();
  const passwordConfirmRef = useRef();
  const emailRef = useRef();
  const streetRef = useRef();
  const cityRef = useRef();
  const stateRef = useRef();
  const zipcodeRef = useRef();




  const handleSubmit = (e) => {
    e.preventDefault();
    const username = usernameRef.current.value;
    const password = passwordRef.current.value;
    const passwordConfirm = passwordConfirmRef.current.value;
    const email = emailRef.current.value;
    const street = streetRef.current.value;
    const city = cityRef.current.value;
    const state = stateRef.current.value;
    const zipcode = zipcodeRef.current.value;
    const id = userInfo.id;

    if (!password || password !== passwordConfirm) return alert('please make sure that you provide a matching password')

    dispatch(updateUserInfo({ username, password, email, street, city, state, zipcode, id }));

    usernameRef.current.value = '';
    passwordRef.current.value = '';
    passwordConfirmRef.current.value = '';
    emailRef.current.value = '';
    streetRef.current.value = '';
    cityRef.current.value = '';
    stateRef.current.value = '';
    zipcodeRef.current.value = '';
  }

  return (
    <div>
      <h1>User Info:</h1>
      <form onSubmit={handleSubmit}>
        Username: <input ref={usernameRef} type="text"/>
        Password: <input ref={passwordRef} type="password" minLength={8} required={true}/>
        Confirm Password: <input ref={passwordConfirmRef} type="password" minLength={8} required={true}/>
        Email: <input ref={emailRef} type="email"/>
        Street: <input ref={streetRef} type="text"/>
        City: <input ref={cityRef} type="text"/>
        State: <input ref={stateRef} type="number"/>
        Zipcode: <input ref={zipcodeRef} type="text"/>
        <button type='submit'>Update Information</button>
      </form>
    </div>
  )
}

export default UserInfoPage;