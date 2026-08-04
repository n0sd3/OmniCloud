package external;

import com.tonikelope.megabasterd.HeadlessTransfer;
import com.tonikelope.megabasterd.HeadlessTransferException;
import com.tonikelope.megabasterd.MegaAPI;

public final class HeadlessTransferPublicApiTest {

    public static void main(String[] args) throws Exception {
        try {
            new HeadlessTransfer(MegaAPI::new).inspectPublic(" ");
            throw new AssertionError("expected invalid input");
        } catch (HeadlessTransferException error) {
            if (error.getCode() != HeadlessTransferException.Code.INVALID_INPUT) {
                throw new AssertionError("unexpected code: " + error.getCode());
            }
        }

        System.out.println("HeadlessTransferPublicApiTest OK");
    }
}
