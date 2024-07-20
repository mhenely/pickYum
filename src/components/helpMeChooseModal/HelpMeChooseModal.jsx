import { useDispatch, useSelector } from "react-redux";
import { removeUserSelection } from "../../redux/slices/userInfoSlice";
import { restaurants } from "../../tempData/restaurants";

const HelpMeChooseModal = ({ selectedList }) => {

  const dispatch = useDispatch()

  return (
    <div>
      {
        selectedList.map((selection) => {
          const name = restaurants[selection].name;
          return (
            <div key={name}>
              {name}
              <button onClick={() => dispatch(removeUserSelection(selection))}>X</button>
            </div>
          )
        })
      }
    </div>
  )
}

export default HelpMeChooseModal;