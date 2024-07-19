import { useSelector, useDispatch } from "react-redux";
import { setIsOpen, addSelection } from "../redux/slices/chooseModalSlice";

import HelpMeChooseModal from "../components/helpMeChooseModal/HelpMeChooseModal";

const RestaurantPage = () => {

const isOpen = useSelector(state => state.chooseModal.isOpen)
const selections = useSelector(state => state.chooseModal.selections)
const dispatch = useDispatch();

  return (
    <>
      Restaurant Page
      {isOpen && <HelpMeChooseModal selectedList={selections}/>}
      <button onClick={() => dispatch(setIsOpen(!isOpen))}>{isOpen ? 'close' : 'show selected'}</button>
      <button onClick={() => dispatch(addSelection('Panda Express'))}>Add Selection</button>
    </>
  )
}

export default RestaurantPage;