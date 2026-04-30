import { useSelector } from 'react-redux';

const useCurrentUser = () => useSelector(state => state.userInfo.users[0]);

export default useCurrentUser;
