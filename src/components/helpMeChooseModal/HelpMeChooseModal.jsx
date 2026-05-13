import { useDispatch, useSelector } from "react-redux";
import { removeUserSelection } from "../../redux/slices/userInfoSlice";

const HelpMeChooseModal = ({ selectedList }) => {
  const dispatch = useDispatch();
  const customRestaurants = useSelector((state) => state.userInfo.customRestaurants);

  return (
    <div>
      {
        selectedList.map((selection) => {
          const name = customRestaurants[selection]?.name ?? selection;
          return (
            <div key={selection}>
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