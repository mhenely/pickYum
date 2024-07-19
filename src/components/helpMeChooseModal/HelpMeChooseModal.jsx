// need a variable in state to track whether should be opened or closed
// receive list of restaurants already selected
// button to redirect to helpMeChoose route
// button visible on every page except helpMeChoose
// click on button to open/close modal

import { useDispatch, useSelector } from "react-redux";
import { removeSelection } from "../../redux/slices/chooseModalSlice";

const HelpMeChooseModal = ({ selectedList }) => {

  const dispatch = useDispatch()

  return (
    <div>
      {
        selectedList.map((selection) => {
          return (
            <div key={selection.name}>
              {selection.name}
              <button onClick={() => dispatch(removeSelection(selection.name))}>X</button>
            </div>
          )
        })
      }
    </div>
  )
}

export default HelpMeChooseModal;