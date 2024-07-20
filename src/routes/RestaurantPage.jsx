import { useSelector, useDispatch } from "react-redux";
import { setIsOpen } from "../redux/slices/chooseModalSlice";
import { addUserSelection } from "../redux/slices/userInfoSlice";

import HelpMeChooseModal from "../components/helpMeChooseModal/HelpMeChooseModal";

const RestaurantPage = () => {

const isOpen = useSelector(state => state.chooseModal.isOpen)
const selections = useSelector(state => state.userInfo.users[0].selections)
const dispatch = useDispatch();

  return (
    <>
      Restaurant Page
      {isOpen && <HelpMeChooseModal selectedList={selections}/>}
      <button onClick={() => dispatch(setIsOpen(!isOpen))}>{isOpen ? 'close' : 'show selected'}</button>
      <button onClick={() => dispatch(addUserSelection(40))}>Add Selection</button>
    </>
  )
}

export default RestaurantPage;