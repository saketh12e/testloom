package example;

import com.microsoft.playwright.Browser;
import com.microsoft.playwright.BrowserContext;
import com.microsoft.playwright.Page;
import com.microsoft.playwright.Playwright;
import org.junit.jupiter.api.Test;
import static com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat;

/** Independent runtime smoke test; no cart server or coupon journey required. */
public class BrowserSmokeTest {
  @Test
  void editsAGiftNote() {
    try (Playwright playwright = Playwright.create();
         Browser browser = playwright.chromium().launch();
         BrowserContext context = browser.newContext()) {
      Page page = context.newPage();
      page.setContent("<label for='note'>Gift note</label><input id='note'>");
      page.getByLabel("Gift note").fill("Enjoy your everyday essentials.");
      assertThat(page.getByLabel("Gift note")).hasValue("Enjoy your everyday essentials.");
    }
  }
}
